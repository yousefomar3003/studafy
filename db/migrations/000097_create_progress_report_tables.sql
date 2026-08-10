-- ST-176: per-student term progress report lifecycle and teacher term comments.
--
-- progress_report_jobs follows the same tenant-safe async lifecycle as report_export_jobs
-- (000060): normalized student/term columns, a terminal-state CHECK, no jsonb (artifact parameters
-- live in the durable BullMQ payload), and the framework's apply_tenant_isolation wiring.
--
-- teacher_term_comments is a user-facing read model gated the same way student_term_summaries is
-- (000065): SELECT-only grant, a RESTRICTIVE role_scope_visibility policy over
-- app.can_read_student(), and writes deferred to a future SECURITY DEFINER seam.

SET LOCAL ROLE studafy_admin;

CREATE TYPE app.progress_report_status AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE app.progress_report_jobs (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_progress_report_jobs PRIMARY KEY,
  school_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  student_id uuid NOT NULL,
  academic_term_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  status app.progress_report_status NOT NULL DEFAULT 'pending',
  storage_key text,
  error_message text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz(3),
  CONSTRAINT uq_progress_report_jobs_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_progress_report_jobs_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_progress_report_jobs_requested_by
    FOREIGN KEY (requested_by_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_progress_report_jobs_student
    FOREIGN KEY (student_id, school_id) REFERENCES app.students (id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_progress_report_jobs_term
    FOREIGN KEY (academic_term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_progress_report_jobs_storage_key CHECK (
    storage_key IS NULL OR (storage_key = btrim(storage_key) AND storage_key <> '')
  ),
  CONSTRAINT ck_progress_report_jobs_error_message CHECK (
    error_message IS NULL OR (error_message = btrim(error_message) AND error_message <> '')
  ),
  CONSTRAINT ck_progress_report_jobs_terminal_state CHECK (
    (status IN ('pending', 'processing') AND storage_key IS NULL
      AND error_message IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND storage_key IS NOT NULL
      AND error_message IS NULL AND completed_at IS NOT NULL)
    OR
    (status = 'failed' AND storage_key IS NULL
      AND error_message IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT ck_progress_report_jobs_completed_at CHECK (
    completed_at IS NULL OR completed_at >= created_at
  )
);

CREATE INDEX idx_progress_report_jobs_lookup
  ON app.progress_report_jobs (school_id, requested_by_user_id, status, created_at DESC);

CREATE INDEX idx_progress_report_jobs_queue
  ON app.progress_report_jobs (school_id, status, created_at)
  WHERE status IN ('pending', 'processing');

CREATE TABLE app.teacher_term_comments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_teacher_term_comments PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  class_id uuid NOT NULL,
  academic_term_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  comment text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_teacher_term_comments_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_teacher_term_comments_one_per_class
    UNIQUE (school_id, student_id, class_id, academic_term_id),
  CONSTRAINT fk_teacher_term_comments_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_teacher_term_comments_student
    FOREIGN KEY (student_id, school_id) REFERENCES app.students (id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_teacher_term_comments_class
    FOREIGN KEY (class_id, school_id) REFERENCES app.classes (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_teacher_term_comments_term
    FOREIGN KEY (academic_term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_teacher_term_comments_author
    FOREIGN KEY (author_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_teacher_term_comments_comment CHECK (
    comment = btrim(comment) AND comment <> '' AND length(comment) <= 2000
  ),
  CONSTRAINT ck_teacher_term_comments_timestamps CHECK (updated_at >= created_at)
);

REVOKE ALL PRIVILEGES ON TABLE app.progress_report_jobs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.progress_report_jobs TO studafy_app;

REVOKE ALL ON TYPE app.progress_report_status FROM PUBLIC;
GRANT USAGE ON TYPE app.progress_report_status TO studafy_app;

-- studafy_app is named explicitly, not just PUBLIC: default privileges grant it full DML on every
-- table studafy_admin creates in app, so the SELECT-only grant below must revoke from studafy_app
-- directly. Writes will go through a tenant-checked SECURITY DEFINER seam (see 000065).
REVOKE ALL PRIVILEGES ON TABLE app.teacher_term_comments FROM PUBLIC, studafy_app;
GRANT SELECT ON TABLE app.teacher_term_comments TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'progress_report_jobs');
SELECT app.apply_tenant_isolation('app', 'teacher_term_comments');

CREATE POLICY role_scope_visibility ON app.teacher_term_comments
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(student_id));

COMMENT ON TABLE app.progress_report_jobs IS
  'Per-student term progress report lifecycle. Artifact parameters live in the durable BullMQ payload; this table is the tenant-safe status and retrieval authority.';
COMMENT ON COLUMN app.progress_report_jobs.error_message IS
  'Sanitized internal diagnostic. API responses expose only a generic failure message.';
COMMENT ON TABLE app.teacher_term_comments IS
  'One teacher comment per student, class and academic term. Select-only for studafy_app; writes go through a tenant-checked SECURITY DEFINER seam.';

RESET ROLE;
