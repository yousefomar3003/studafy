-- ST-046x: audit explorer. Adds the 'read' verb to app.audit_action (the audit log must be able to
-- record that the audit API itself was read) and the durable lifecycle table for async CSV exports of
-- the audit log, mirroring app.finance_report_jobs (000073).

SET LOCAL ROLE studafy_admin;

-- The read verb: the audit explorer writes one row per paged read of app.audit_logs, target_table
-- 'audit_logs'. ck_audit_logs_payload already permits payloads on non-DML actions, so the read's
-- filter can ride in new_values.
ALTER TYPE app.audit_action ADD VALUE 'read';

CREATE TYPE app.audit_export_status AS ENUM (
  'queued',
  'processing',
  'completed',
  'failed'
);

CREATE TABLE app.audit_export_jobs (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_audit_export_jobs PRIMARY KEY,
  school_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  file_format text NOT NULL,
  status app.audit_export_status NOT NULL DEFAULT 'queued',
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage_key text,
  failure_message text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at timestamptz(3),
  completed_at timestamptz(3),
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_audit_export_jobs_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_audit_export_jobs_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_audit_export_jobs_user
    FOREIGN KEY (requested_by_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_audit_export_jobs_file_format CHECK (file_format = 'csv'),
  CONSTRAINT ck_audit_export_jobs_parameters_object CHECK (
    jsonb_typeof(parameters) = 'object'
  ),
  CONSTRAINT ck_audit_export_jobs_storage_key CHECK (
    storage_key IS NULL OR (storage_key = btrim(storage_key) AND storage_key <> '')
  ),
  CONSTRAINT ck_audit_export_jobs_failure_message CHECK (
    failure_message IS NULL OR
      (failure_message = btrim(failure_message) AND failure_message <> '' AND length(failure_message) <= 1000)
  ),
  CONSTRAINT ck_audit_export_jobs_terminal_state CHECK (
    (status IN ('queued', 'processing')
      AND storage_key IS NULL AND failure_message IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed'
      AND storage_key IS NOT NULL AND failure_message IS NULL AND completed_at IS NOT NULL)
    OR
    (status = 'failed'
      AND storage_key IS NULL AND failure_message IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT ck_audit_export_jobs_timestamps CHECK (
    updated_at >= created_at
    AND (started_at IS NULL OR started_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= created_at)
  )
);

CREATE INDEX idx_audit_export_jobs_user
  ON app.audit_export_jobs (school_id, requested_by_user_id, status, created_at DESC);
CREATE INDEX idx_audit_export_jobs_queue
  ON app.audit_export_jobs (school_id, status, created_at)
  WHERE status IN ('queued', 'processing');

REVOKE ALL PRIVILEGES ON TABLE app.audit_export_jobs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.audit_export_jobs TO studafy_app;

REVOKE ALL ON TYPE app.audit_export_status FROM PUBLIC;
GRANT USAGE ON TYPE app.audit_export_status TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'audit_export_jobs');

COMMENT ON TABLE app.audit_export_jobs IS
  'Tenant-scoped async audit-log CSV export lifecycle. parameters holds the resolved created_at range and filters.';

RESET ROLE;
