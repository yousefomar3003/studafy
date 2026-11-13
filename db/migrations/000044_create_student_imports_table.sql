-- Tracks student CSV import lifecycle: upload → validation → confirm → processing → done.
-- Stores parsed CSV data as JSONB to avoid external file storage; row-level errors accompany
-- the record for the dry-run validation report.

SET ROLE studafy_admin;

CREATE TYPE app.import_status AS ENUM (
  'uploaded', 'validated', 'confirmed', 'processing', 'completed', 'failed'
);

CREATE TABLE app.student_imports (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id       uuid NOT NULL,
  uploaded_by     uuid NOT NULL,
  status          app.import_status NOT NULL DEFAULT 'uploaded',
  file_name       text NOT NULL,
  idempotency_key text,
  row_count       int NOT NULL DEFAULT 0,
  valid_rows      int NOT NULL DEFAULT 0,
  error_rows      int NOT NULL DEFAULT 0,
  rows_data       jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary         jsonb,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at    timestamptz,
  completed_at    timestamptz,

  CONSTRAINT fk_student_imports_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id),
  CONSTRAINT fk_student_imports_user FOREIGN KEY (uploaded_by, school_id)
    REFERENCES app.users (id, school_id)
);

CREATE UNIQUE INDEX uq_student_imports_idempotency_key
  ON app.student_imports (school_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_student_imports_school_status
  ON app.student_imports (school_id, status, created_at DESC);

SELECT app.apply_tenant_isolation('app', 'student_imports');

REVOKE ALL PRIVILEGES ON TABLE app.student_imports FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.student_imports TO studafy_app;

REVOKE ALL ON TYPE app.import_status FROM PUBLIC;
GRANT USAGE ON TYPE app.import_status TO studafy_app;

RESET ROLE;
