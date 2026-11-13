-- Manual grants: what Studafy staff give a school or a person by hand, usually because they paid in
-- cash or by transfer outside the online checkout (the platform console, SUPER_ADMIN only).
--
--   storage  a school's upload cap is raised to cap_bytes: the 100 GB / 1 TB tiers, or any custom
--            figure (a pilot's 20 GB). The quota check (storage/quota-service.ts) takes the largest
--            of the included cap, a live Stripe storage add-on (000205) and an in-force grant.
--   tier     one person holds a feature tier (a student's paid tier, the AI add-on, a parent's
--            Family+): the feature resolver reads it as one more grant source
--            (modules/features/grants.ts), next to purchases and license seats. When a person also
--            pays through the App Store or Google Play, the grants simply add up -- the feature is on
--            while either covers it, so the later end date wins.
--
-- A grant is in force while starts_at <= now() < ends_at and it is not revoked. Nothing reads a
-- status column, so an ended grant stops counting at its end date without any job; nothing is ever
-- deleted -- a school past its smaller cap keeps every file, and a revoked or ended grant stays as
-- history. Rows are never deleted by the app (studafy_app has no DELETE).
--
-- The optional amount and receipt record what was paid. The receipt is uploaded through the license
-- receipt flow (content class license.receipt) and lives under the school's permanent/ prefix, so
-- app.referenced_storage_keys (000204) is replaced below to list this column too.

SET ROLE studafy_admin;

CREATE TABLE app.manual_grants (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_manual_grants PRIMARY KEY,
  school_id uuid NOT NULL,
  kind text NOT NULL,
  -- storage grants
  cap_bytes bigint,
  -- tier grants
  user_id uuid,
  plan_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL,
  amount_minor bigint,
  currency_id uuid,
  receipt_storage_key text,
  -- The Studafy operator. Not a foreign key: platform staff sign in to their own home school.
  granted_by_user_id uuid NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_manual_grants_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_manual_grants_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_manual_grants_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_manual_grants_plan FOREIGN KEY (plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_manual_grants_currency FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_manual_grants_kind CHECK (kind IN ('storage', 'tier')),
  CONSTRAINT ck_manual_grants_storage_shape CHECK (
    kind <> 'storage' OR (cap_bytes IS NOT NULL AND user_id IS NULL AND plan_id IS NULL)
  ),
  CONSTRAINT ck_manual_grants_tier_shape CHECK (
    kind <> 'tier' OR (cap_bytes IS NULL AND user_id IS NOT NULL AND plan_id IS NOT NULL)
  ),
  CONSTRAINT ck_manual_grants_cap_bytes CHECK (cap_bytes IS NULL OR cap_bytes > 0),
  CONSTRAINT ck_manual_grants_period CHECK (ends_at > starts_at),
  CONSTRAINT ck_manual_grants_reason CHECK (
    reason = btrim(reason) AND reason <> '' AND char_length(reason) <= 1000
  ),
  CONSTRAINT ck_manual_grants_amount CHECK (
    (amount_minor IS NULL) = (currency_id IS NULL) AND (amount_minor IS NULL OR amount_minor >= 0)
  ),
  CONSTRAINT ck_manual_grants_receipt_storage_key CHECK (
    receipt_storage_key IS NULL
    OR receipt_storage_key LIKE 'permanent/' || school_id::text || '/%'
  ),
  CONSTRAINT ck_manual_grants_revoked CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL AND revoke_reason IS NOT NULL
        AND revoke_reason = btrim(revoke_reason) AND revoke_reason <> ''
        AND char_length(revoke_reason) <= 1000)
  ),
  CONSTRAINT ck_manual_grants_timestamps CHECK (updated_at >= created_at)
);

-- A school's grants, newest end first: the console card, the quota check and the Storage tab.
CREATE INDEX idx_manual_grants_school_kind_ends
  ON app.manual_grants (school_id, kind, ends_at DESC);
-- One person's grants: the feature resolver. Also covers the composite user foreign key.
CREATE INDEX idx_manual_grants_user ON app.manual_grants (user_id, school_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX idx_manual_grants_plan_id ON app.manual_grants (plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX idx_manual_grants_currency_id ON app.manual_grants (currency_id)
  WHERE currency_id IS NOT NULL;

COMMENT ON TABLE app.manual_grants IS
  'Storage caps and feature tiers Studafy staff grant by hand, e.g. after a cash payment (000211). In force while starts_at <= now() < ends_at and not revoked; never deleted.';

REVOKE ALL PRIVILEGES ON TABLE app.manual_grants FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.manual_grants TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'manual_grants');

-- The receipt column joins every other storage-key column in the "still referenced" check, so the
-- delete paths and the orphan report never treat a grant's receipt as unused.
CREATE OR REPLACE FUNCTION app.referenced_storage_keys(p_keys text[])
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  WITH school AS (SELECT current_setting('app.school_id')::uuid AS id),
  wanted AS (SELECT DISTINCT unnest(p_keys) AS key)
  SELECT w.key FROM wanted AS w, school AS s
  WHERE EXISTS (SELECT 1 FROM app.materials AS t
                WHERE t.school_id = s.id
                  AND (t.storage_key = w.key OR t.thumbnail_key = w.key OR t.preview_key = w.key))
     OR EXISTS (SELECT 1 FROM app.assignment_attachments AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.assignment_questions AS t
                WHERE t.school_id = s.id AND t.image_storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.submission_attachments AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.message_attachments AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.expense_cache AS t
                WHERE t.school_id = s.id AND t.attachment_storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.license_payment_receipts AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.license_payments AS t
                WHERE t.school_id = s.id AND t.receipt_storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.manual_grants AS t
                WHERE t.school_id = s.id AND t.receipt_storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.record_documents AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.student_imports AS t
                WHERE t.school_id = s.id AND t.source_storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.report_export_jobs AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.progress_report_jobs AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.audit_export_jobs AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.finance_report_jobs AS t
                WHERE t.school_id = s.id AND t.object_key = w.key)
     OR EXISTS (SELECT 1 FROM app.data_subject_requests AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
$function$;

COMMENT ON FUNCTION app.referenced_storage_keys(text[]) IS
  'The given keys some row of app.school_id still points at (000204, 000211). Every storage-key column is listed here.';

RESET ROLE;
