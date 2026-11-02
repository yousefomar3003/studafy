-- School applications: the website's sign-up flow for a prospective school owner.
--
-- The applicant signs in with Google or Microsoft (no Studafy account exists yet), fills in their
-- school's details and uploads a document proving they own or run it. Studafy staff review the
-- application in the platform console (`/portal/platform/applications`); approving it provisions
-- the school with the applicant as its ORG_ADMIN, linked to the same (provider, subject) they signed
-- up with, so they sign straight in afterwards.
--
-- Global, not tenant-scoped: an application exists before its school does. Access follows
-- app.sales_inquiries (000125): every privilege revoked from the runtime role, RLS forced, and a
-- single policy naming `studafy_admin`, so only `withSystemTx` can reach it.
--
-- Two notification emails are tracked on the row, each with the dispatcher's bounded-retry columns:
--   team_*      -- "new application" to the onboarding inbox (platform setting below), on submit.
--   applicant_* -- the decision (approved / rejected) to the applicant's own sign-in address.

SET ROLE studafy_admin;

CREATE TABLE app.school_applications (
  id                          uuid        DEFAULT gen_random_uuid()
                                          CONSTRAINT pk_school_applications PRIMARY KEY,
  status                      text        NOT NULL DEFAULT 'pending',

  -- Who applied: the verified OIDC identity they signed in with.
  provider                    text        NOT NULL,
  provider_subject            text        NOT NULL,
  applicant_email             text        NOT NULL,
  applicant_name              text        NOT NULL,
  applicant_job_title         text,
  applicant_phone             text        NOT NULL,

  -- The school.
  school_name                 text        NOT NULL,
  school_email                text,
  country_id                  uuid        NOT NULL,
  default_currency_id         uuid        NOT NULL,
  city                        text        NOT NULL,
  address                     text        NOT NULL,
  website                     text,
  student_count               integer,
  message                     text,

  -- Proof of ownership, promoted to permanent storage on submit.
  proof_storage_key           text        NOT NULL,
  proof_file_name             text        NOT NULL,
  proof_content_type          text        NOT NULL,
  proof_size_bytes            integer     NOT NULL,

  -- Review.
  reviewed_by_user_id         uuid,
  reviewed_at                 timestamptz,
  review_note                 text,
  school_id                   uuid,

  team_notified_at            timestamptz,
  team_notify_attempts        smallint    NOT NULL DEFAULT 0,
  team_last_notify_error      text,
  applicant_notified_at       timestamptz,
  applicant_notify_attempts   smallint    NOT NULL DEFAULT 0,
  applicant_last_notify_error text,

  created_at                  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_school_applications_country
    FOREIGN KEY (country_id) REFERENCES app.countries (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_school_applications_currency
    FOREIGN KEY (default_currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_school_applications_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_school_applications_status CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT ck_school_applications_provider CHECK (provider IN ('google', 'microsoft', 'mock')),
  CONSTRAINT ck_school_applications_provider_subject CHECK (
    provider_subject <> '' AND char_length(provider_subject) <= 255
  ),
  CONSTRAINT ck_school_applications_applicant_email CHECK (
    applicant_email = lower(btrim(applicant_email)) AND applicant_email <> ''
    AND char_length(applicant_email) <= 320
  ),
  CONSTRAINT ck_school_applications_applicant_name CHECK (
    applicant_name = btrim(applicant_name) AND applicant_name <> ''
    AND char_length(applicant_name) <= 200
  ),
  CONSTRAINT ck_school_applications_applicant_job_title CHECK (
    applicant_job_title IS NULL OR char_length(applicant_job_title) <= 120
  ),
  CONSTRAINT ck_school_applications_applicant_phone CHECK (
    applicant_phone = btrim(applicant_phone) AND applicant_phone <> ''
    AND char_length(applicant_phone) <= 50
  ),
  CONSTRAINT ck_school_applications_school_name CHECK (
    school_name = btrim(school_name) AND school_name <> '' AND char_length(school_name) <= 200
  ),
  CONSTRAINT ck_school_applications_school_email CHECK (
    school_email IS NULL OR (school_email = lower(btrim(school_email))
    AND char_length(school_email) <= 320)
  ),
  CONSTRAINT ck_school_applications_city CHECK (
    city = btrim(city) AND city <> '' AND char_length(city) <= 120
  ),
  CONSTRAINT ck_school_applications_address CHECK (
    address = btrim(address) AND address <> '' AND char_length(address) <= 500
  ),
  CONSTRAINT ck_school_applications_website CHECK (website IS NULL OR char_length(website) <= 300),
  CONSTRAINT ck_school_applications_student_count CHECK (
    student_count IS NULL OR student_count BETWEEN 0 AND 1000000
  ),
  CONSTRAINT ck_school_applications_message CHECK (message IS NULL OR char_length(message) <= 5000),
  -- Proofs live under the reserved `school-applications` segment of the storage key scheme
  -- (apps/api/src/lib/storage/keys.ts), never under a real school's prefix.
  CONSTRAINT ck_school_applications_proof_storage_key CHECK (
    proof_storage_key LIKE 'permanent/school-applications/%'
  ),
  CONSTRAINT ck_school_applications_proof_file_name CHECK (
    proof_file_name <> '' AND char_length(proof_file_name) <= 255
  ),
  CONSTRAINT ck_school_applications_proof_content_type CHECK (
    proof_content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
  ),
  CONSTRAINT ck_school_applications_proof_size CHECK (
    proof_size_bytes > 0 AND proof_size_bytes <= 10485760
  ),
  CONSTRAINT ck_school_applications_review_note CHECK (
    review_note IS NULL OR char_length(review_note) <= 2000
  ),
  -- A decision always records who made it and when; an approval always names its school.
  CONSTRAINT ck_school_applications_review CHECK (
    (status = 'pending' AND reviewed_at IS NULL AND school_id IS NULL)
    OR (status = 'rejected' AND reviewed_at IS NOT NULL AND school_id IS NULL)
    OR (status = 'approved' AND reviewed_at IS NOT NULL AND school_id IS NOT NULL)
  ),
  CONSTRAINT ck_school_applications_team_notify_attempts CHECK (team_notify_attempts >= 0),
  CONSTRAINT ck_school_applications_applicant_notify_attempts CHECK (
    applicant_notify_attempts >= 0
  ),
  CONSTRAINT ck_school_applications_team_last_notify_error CHECK (
    team_last_notify_error IS NULL OR char_length(team_last_notify_error) <= 1000
  ),
  CONSTRAINT ck_school_applications_applicant_last_notify_error CHECK (
    applicant_last_notify_error IS NULL OR char_length(applicant_last_notify_error) <= 1000
  ),
  CONSTRAINT ck_school_applications_timestamps CHECK (updated_at >= created_at)
);

-- One open application per sign-in identity; a rejected applicant may apply again.
CREATE UNIQUE INDEX uq_school_applications_pending_identity
  ON app.school_applications (provider, provider_subject) WHERE status = 'pending';
-- The applicant's own status page reads their newest application.
CREATE INDEX idx_school_applications_identity_created
  ON app.school_applications (provider, provider_subject, created_at DESC);
-- The console lists newest first, optionally filtered by status.
CREATE INDEX idx_school_applications_status_created
  ON app.school_applications (status, created_at DESC);
CREATE INDEX idx_school_applications_created ON app.school_applications (created_at DESC);
-- The dispatcher's claims: only the (few) rows still awaiting an email.
CREATE INDEX idx_school_applications_pending_team_notify
  ON app.school_applications (created_at) WHERE team_notified_at IS NULL;
CREATE INDEX idx_school_applications_pending_applicant_notify
  ON app.school_applications (reviewed_at)
  WHERE applicant_notified_at IS NULL AND status <> 'pending';

REVOKE ALL PRIVILEGES ON TABLE app.school_applications FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE app.school_applications FROM studafy_app;

ALTER TABLE app.school_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.school_applications FORCE ROW LEVEL SECURITY;

CREATE POLICY global_admin_only ON app.school_applications
  AS PERMISSIVE FOR ALL TO studafy_admin USING (true) WITH CHECK (true);

-- Where the dispatcher sends new-application notifications. Mutable from the platform console's
-- settings page, so changing the onboarding inbox needs no deploy.
INSERT INTO app.platform_settings (key, description, value_type, text_value, sensitivity, is_mutable)
VALUES (
  'onboarding.application_notification_email',
  'Email address that receives a notification for every new school sign-up application.',
  'text',
  'onboarding@studafy.com',
  'internal',
  true
)
ON CONFLICT (key) DO NOTHING;

RESET ROLE;
