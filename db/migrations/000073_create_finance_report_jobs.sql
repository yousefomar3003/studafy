-- ST-126: durable finance report export lifecycle and JoFotara generation audit mapping.

SET LOCAL ROLE studafy_admin;

CREATE TYPE app.finance_report_type AS ENUM (
  'ar_aging',
  'general_ledger',
  'collections_vs_due',
  'family_statement',
  'joinvoice_export'
);

CREATE TYPE app.finance_report_status AS ENUM (
  'queued',
  'processing',
  'completed',
  'failed'
);

CREATE TYPE app.joinvoice_submission_status AS ENUM (
  'generated',
  'submitted',
  'rejected'
);

CREATE TABLE app.finance_report_jobs (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_finance_report_jobs PRIMARY KEY,
  school_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  report_type app.finance_report_type NOT NULL,
  file_format text NOT NULL,
  status app.finance_report_status NOT NULL DEFAULT 'queued',
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  object_key text,
  signed_url text,
  signed_url_expires_at timestamptz(3),
  failure_message text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at timestamptz(3),
  completed_at timestamptz(3),
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_finance_report_jobs_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_finance_report_jobs_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finance_report_jobs_user
    FOREIGN KEY (requested_by_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_finance_report_jobs_file_format CHECK (
    (report_type = 'joinvoice_export' AND file_format IN ('xml', 'json'))
    OR (report_type <> 'joinvoice_export' AND file_format IN ('csv', 'pdf'))
  ),
  CONSTRAINT ck_finance_report_jobs_parameters_object CHECK (
    jsonb_typeof(parameters) = 'object'
  ),
  CONSTRAINT ck_finance_report_jobs_signed_url CHECK (
    signed_url IS NULL OR (signed_url = btrim(signed_url) AND signed_url <> '')
  ),
  CONSTRAINT ck_finance_report_jobs_object_key CHECK (
    object_key IS NULL OR (object_key = btrim(object_key) AND object_key <> '')
  ),
  CONSTRAINT ck_finance_report_jobs_failure_message CHECK (
    failure_message IS NULL OR
      (failure_message = btrim(failure_message) AND failure_message <> '' AND length(failure_message) <= 1000)
  ),
  CONSTRAINT ck_finance_report_jobs_terminal_state CHECK (
    (status IN ('queued', 'processing')
      AND object_key IS NULL AND signed_url IS NULL AND signed_url_expires_at IS NULL
      AND failure_message IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed'
      AND object_key IS NOT NULL AND signed_url IS NOT NULL AND signed_url_expires_at IS NOT NULL
      AND failure_message IS NULL AND completed_at IS NOT NULL)
    OR
    (status = 'failed'
      AND object_key IS NULL AND signed_url IS NULL AND signed_url_expires_at IS NULL
      AND failure_message IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT ck_finance_report_jobs_timestamps CHECK (
    updated_at >= created_at
    AND (started_at IS NULL OR started_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= created_at)
  ),
  CONSTRAINT ck_finance_report_jobs_expiry CHECK (
    signed_url_expires_at IS NULL OR signed_url_expires_at > created_at
  )
);

CREATE INDEX idx_finance_report_jobs_user
  ON app.finance_report_jobs (school_id, requested_by_user_id, status, created_at DESC);
CREATE INDEX idx_finance_report_jobs_queue
  ON app.finance_report_jobs (school_id, status, created_at)
  WHERE status IN ('queued', 'processing');

CREATE TABLE app.joinvoice_export_logs (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_joinvoice_export_logs PRIMARY KEY,
  school_id uuid NOT NULL,
  erpnext_invoice_id text NOT NULL,
  joinvoice_uuid uuid NOT NULL,
  canonical_sha256 varchar(64) NOT NULL,
  submission_status app.joinvoice_submission_status NOT NULL DEFAULT 'generated',
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_joinvoice_export_logs_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_joinvoice_export_logs_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_joinvoice_export_logs_invoice_id CHECK (
    erpnext_invoice_id = btrim(erpnext_invoice_id)
      AND erpnext_invoice_id <> ''
      AND length(erpnext_invoice_id) <= 255
  ),
  CONSTRAINT ck_joinvoice_export_logs_hash CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX idx_joinvoice_export_invoice_unique
  ON app.joinvoice_export_logs (school_id, erpnext_invoice_id);
CREATE UNIQUE INDEX idx_joinvoice_export_uuid_unique
  ON app.joinvoice_export_logs (school_id, joinvoice_uuid);

REVOKE ALL PRIVILEGES ON TABLE
  app.finance_report_jobs, app.joinvoice_export_logs
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE
  app.finance_report_jobs, app.joinvoice_export_logs
TO studafy_app;

REVOKE ALL ON TYPE
  app.finance_report_type, app.finance_report_status, app.joinvoice_submission_status
FROM PUBLIC;
GRANT USAGE ON TYPE
  app.finance_report_type, app.finance_report_status, app.joinvoice_submission_status
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'finance_report_jobs');
SELECT app.apply_tenant_isolation('app', 'joinvoice_export_logs');

COMMENT ON TABLE app.finance_report_jobs IS
  'Tenant-scoped async finance export lifecycle. signed_url is the current refreshable 24-hour URL.';
COMMENT ON TABLE app.joinvoice_export_logs IS
  'One immutable JoFotara generation mapping per tenant ERPNext Sales Invoice.';

RESET ROLE;
