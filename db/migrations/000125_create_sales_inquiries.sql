-- Sales inquiries: the "Talk to us" form on the public marketing site. A prospective school leaves
-- its contact details; Studafy staff work the inquiry from the platform console
-- (`/portal/platform/inquiries`) and are emailed about each new one by the worker's email
-- dispatcher.
--
-- Global, not tenant-scoped: an inquiry arrives before any school exists, so there is no school_id
-- to isolate on. Access follows app.billing_events (000016): every privilege revoked from the
-- runtime role, RLS forced, and a single policy naming `studafy_admin`, so only `withSystemTx`
-- (the public submit endpoint, the SUPER_ADMIN console and the worker) can reach it.
--
-- notified_at / notify_attempts / last_notify_error track the staff notification email. The
-- dispatcher claims rows with notified_at IS NULL and gives up after a bounded number of attempts,
-- so an address SES rejects never spins forever.

SET ROLE studafy_admin;

CREATE TABLE app.sales_inquiries (
  id                uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_sales_inquiries PRIMARY KEY,
  full_name         text        NOT NULL,
  email             text        NOT NULL,
  phone             text,
  school_name       text        NOT NULL,
  job_title         text,
  country           text,
  student_count     integer,
  message           text,
  source_path       text,
  status            text        NOT NULL DEFAULT 'new',
  internal_notes    text,
  notified_at       timestamptz,
  notify_attempts   smallint    NOT NULL DEFAULT 0,
  last_notify_error text,
  created_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT ck_sales_inquiries_full_name CHECK (
    full_name = btrim(full_name) AND full_name <> '' AND char_length(full_name) <= 200
  ),
  CONSTRAINT ck_sales_inquiries_email CHECK (
    email = btrim(email) AND email <> '' AND char_length(email) <= 320
  ),
  CONSTRAINT ck_sales_inquiries_phone CHECK (phone IS NULL OR char_length(phone) <= 50),
  CONSTRAINT ck_sales_inquiries_school_name CHECK (
    school_name = btrim(school_name) AND school_name <> '' AND char_length(school_name) <= 200
  ),
  CONSTRAINT ck_sales_inquiries_job_title CHECK (job_title IS NULL OR char_length(job_title) <= 120),
  CONSTRAINT ck_sales_inquiries_country CHECK (country IS NULL OR char_length(country) <= 120),
  CONSTRAINT ck_sales_inquiries_student_count CHECK (
    student_count IS NULL OR student_count BETWEEN 0 AND 1000000
  ),
  CONSTRAINT ck_sales_inquiries_message CHECK (message IS NULL OR char_length(message) <= 5000),
  CONSTRAINT ck_sales_inquiries_source_path CHECK (
    source_path IS NULL OR char_length(source_path) <= 300
  ),
  CONSTRAINT ck_sales_inquiries_status CHECK (status IN ('new', 'contacted', 'won', 'lost')),
  CONSTRAINT ck_sales_inquiries_internal_notes CHECK (
    internal_notes IS NULL OR char_length(internal_notes) <= 5000
  ),
  CONSTRAINT ck_sales_inquiries_notify_attempts CHECK (notify_attempts >= 0),
  CONSTRAINT ck_sales_inquiries_last_notify_error CHECK (
    last_notify_error IS NULL OR char_length(last_notify_error) <= 1000
  ),
  CONSTRAINT ck_sales_inquiries_timestamps CHECK (updated_at >= created_at)
);

-- The console lists newest first, optionally filtered by status.
CREATE INDEX idx_sales_inquiries_status_created ON app.sales_inquiries (status, created_at DESC);
CREATE INDEX idx_sales_inquiries_created ON app.sales_inquiries (created_at DESC);
-- The dispatcher's claim: only the (few) rows still awaiting their notification email.
CREATE INDEX idx_sales_inquiries_pending_notify
  ON app.sales_inquiries (created_at) WHERE notified_at IS NULL;

REVOKE ALL PRIVILEGES ON TABLE app.sales_inquiries FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE app.sales_inquiries FROM studafy_app;

ALTER TABLE app.sales_inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sales_inquiries FORCE ROW LEVEL SECURITY;

CREATE POLICY global_admin_only ON app.sales_inquiries
  AS PERMISSIVE FOR ALL TO studafy_admin USING (true) WITH CHECK (true);

-- Where the dispatcher sends new-inquiry notifications. Mutable from the platform console's
-- settings page, so changing the sales inbox needs no deploy.
INSERT INTO app.platform_settings (key, description, value_type, text_value, sensitivity, is_mutable)
VALUES (
  'sales.inquiry_notification_email',
  'Email address that receives a notification for every new "Talk to us" inquiry.',
  'text',
  'sales@studafy.com',
  'internal',
  true
)
ON CONFLICT (key) DO NOTHING;

RESET ROLE;
