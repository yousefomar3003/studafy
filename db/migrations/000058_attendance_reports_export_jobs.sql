-- ST-111: tenant-scoped attendance analytics and asynchronous export state.
--
-- Attendance keeps class_id/session_date normalized on attendance_sessions. The report indexes
-- therefore optimize the real join path instead of copying those attributes into
-- attendance_records.

SET LOCAL ROLE studafy_admin;

CREATE TYPE app.report_export_type AS ENUM ('attendance_summary');
CREATE TYPE app.report_export_format AS ENUM ('xlsx', 'pdf');
CREATE TYPE app.report_export_status AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE app.report_export_jobs (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_report_export_jobs PRIMARY KEY,
  school_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  report_type app.report_export_type NOT NULL DEFAULT 'attendance_summary',
  file_format app.report_export_format NOT NULL,
  status app.report_export_status NOT NULL DEFAULT 'pending',
  storage_key text,
  error_message text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz(3),
  CONSTRAINT uq_report_export_jobs_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_report_export_jobs_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_export_jobs_requested_by
    FOREIGN KEY (requested_by_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_report_export_jobs_storage_key CHECK (
    storage_key IS NULL OR (storage_key = btrim(storage_key) AND storage_key <> '')
  ),
  CONSTRAINT ck_report_export_jobs_error_message CHECK (
    error_message IS NULL OR (error_message = btrim(error_message) AND error_message <> '')
  ),
  CONSTRAINT ck_report_export_jobs_terminal_state CHECK (
    (status IN ('pending', 'processing') AND storage_key IS NULL
      AND error_message IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND storage_key IS NOT NULL
      AND error_message IS NULL AND completed_at IS NOT NULL)
    OR
    (status = 'failed' AND storage_key IS NULL
      AND error_message IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT ck_report_export_jobs_completed_at CHECK (
    completed_at IS NULL OR completed_at >= created_at
  )
);

CREATE INDEX idx_report_export_jobs_lookup
  ON app.report_export_jobs (school_id, requested_by_user_id, status);

-- School-wide finalized-session scans use session_date before class_id. The existing
-- idx_attendance_sessions_school_class_date remains optimal when class_id is supplied.
CREATE INDEX idx_attendance_sessions_reports
  ON app.attendance_sessions (school_id, session_date, class_id, id)
  WHERE status IN ('submitted', 'locked');

-- Cover the two aggregation directions. PostgreSQL propagates these parent indexes to every
-- existing and future attendance_records partition.
CREATE INDEX idx_attendance_records_analytics
  ON app.attendance_records (school_id, attendance_session_id, status, student_id)
  INCLUDE (session_created_at);

CREATE INDEX idx_attendance_records_student_stats
  ON app.attendance_records (school_id, student_id, attendance_session_id, status)
  INCLUDE (session_created_at);

REVOKE ALL PRIVILEGES ON TABLE app.report_export_jobs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.report_export_jobs TO studafy_app;

REVOKE ALL ON TYPE
  app.report_export_type, app.report_export_format, app.report_export_status
FROM PUBLIC;
GRANT USAGE ON TYPE
  app.report_export_type, app.report_export_format, app.report_export_status
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'report_export_jobs');

COMMENT ON TABLE app.report_export_jobs IS
  'Asynchronous export lifecycle. Artifact parameters live in the durable BullMQ payload; this table is the tenant-safe status and retrieval authority.';
COMMENT ON COLUMN app.report_export_jobs.error_message IS
  'Sanitized internal diagnostic. API responses expose only a generic failure message.';

RESET ROLE;
