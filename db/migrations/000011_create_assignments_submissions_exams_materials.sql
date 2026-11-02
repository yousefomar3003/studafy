-- Creates the normalized, school-owned assessment and educational-material model.
-- Composite foreign keys enforce tenant integrity independently of canonical forced RLS.

SET ROLE studafy_admin;

CREATE TYPE app.assignment_status AS ENUM ('draft', 'published', 'closed', 'archived');
CREATE TYPE app.assignment_submission_status AS ENUM (
  'draft', 'submitted', 'late', 'graded', 'returned', 'withdrawn'
);
CREATE TYPE app.exam_status AS ENUM (
  'draft', 'scheduled', 'open', 'closed', 'cancelled', 'archived'
);
CREATE TYPE app.exam_result_status AS ENUM (
  'pending', 'graded', 'published', 'withheld', 'voided'
);
CREATE TYPE app.material_ingest_status AS ENUM ('uploaded', 'processing', 'ready', 'failed');

CREATE TABLE app.assignments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_assignments PRIMARY KEY,
  school_id uuid NOT NULL,
  class_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL,
  last_edited_by_user_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  instructions text,
  status app.assignment_status NOT NULL DEFAULT 'draft',
  available_from timestamptz,
  assigned_at timestamptz,
  due_at timestamptz NOT NULL,
  max_score numeric(10, 2) NOT NULL,
  allow_late_submission boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_assignments_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_assignments_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assignments_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assignments_created_by FOREIGN KEY (created_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assignments_last_edited_by FOREIGN KEY (last_edited_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_assignments_title CHECK (title = btrim(title) AND title <> ''),
  CONSTRAINT ck_assignments_description CHECK (
    description IS NULL OR (description = btrim(description) AND description <> '')
  ),
  CONSTRAINT ck_assignments_instructions CHECK (
    instructions IS NULL OR (instructions = btrim(instructions) AND instructions <> '')
  ),
  CONSTRAINT ck_assignments_max_score CHECK (max_score > 0),
  CONSTRAINT ck_assignments_availability CHECK (
    available_from IS NULL OR due_at >= available_from
  ),
  CONSTRAINT ck_assignments_assignment_time CHECK (
    assigned_at IS NULL OR due_at >= assigned_at
  ),
  CONSTRAINT ck_assignments_lifecycle CHECK (
    (status = 'draft' AND assigned_at IS NULL)
    OR (status <> 'draft' AND assigned_at IS NOT NULL)
  ),
  CONSTRAINT ck_assignments_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.assignment_submissions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_assignment_submissions PRIMARY KEY,
  school_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  last_edited_by_user_id uuid NOT NULL,
  graded_by_user_id uuid,
  status app.assignment_submission_status NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  graded_at timestamptz,
  score numeric(10, 2),
  feedback text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_assignment_submissions_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_assignment_submissions_school_assignment_student
    UNIQUE (school_id, assignment_id, student_id),
  CONSTRAINT fk_assignment_submissions_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assignment_submissions_assignment FOREIGN KEY (assignment_id, school_id)
    REFERENCES app.assignments (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assignment_submissions_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assignment_submissions_last_edited_by
    FOREIGN KEY (last_edited_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assignment_submissions_graded_by FOREIGN KEY (graded_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_assignment_submissions_score CHECK (score IS NULL OR score >= 0),
  CONSTRAINT ck_assignment_submissions_feedback CHECK (
    feedback IS NULL OR (feedback = btrim(feedback) AND feedback <> '')
  ),
  CONSTRAINT ck_assignment_submissions_grading_time CHECK (
    graded_at IS NULL OR (submitted_at IS NOT NULL AND graded_at >= submitted_at)
  ),
  CONSTRAINT ck_assignment_submissions_lifecycle CHECK (
    (status = 'draft'
      AND submitted_at IS NULL AND graded_at IS NULL
      AND graded_by_user_id IS NULL AND score IS NULL)
    OR (status IN ('submitted', 'late', 'returned')
      AND submitted_at IS NOT NULL AND graded_at IS NULL
      AND graded_by_user_id IS NULL AND score IS NULL)
    OR (status = 'graded'
      AND submitted_at IS NOT NULL AND graded_at IS NOT NULL
      AND graded_by_user_id IS NOT NULL AND score IS NOT NULL)
    OR (status = 'withdrawn'
      AND graded_at IS NULL AND graded_by_user_id IS NULL AND score IS NULL)
  ),
  CONSTRAINT ck_assignment_submissions_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.exams (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_exams PRIMARY KEY,
  school_id uuid NOT NULL,
  class_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL,
  last_edited_by_user_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  status app.exam_status NOT NULL DEFAULT 'draft',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  max_score numeric(10, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_exams_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_exams_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exams_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exams_created_by FOREIGN KEY (created_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exams_last_edited_by FOREIGN KEY (last_edited_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_exams_title CHECK (title = btrim(title) AND title <> ''),
  CONSTRAINT ck_exams_description CHECK (
    description IS NULL OR (description = btrim(description) AND description <> '')
  ),
  CONSTRAINT ck_exams_time_range CHECK (ends_at > starts_at),
  CONSTRAINT ck_exams_max_score CHECK (max_score > 0),
  CONSTRAINT ck_exams_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.exam_results (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_exam_results PRIMARY KEY,
  school_id uuid NOT NULL,
  exam_id uuid NOT NULL,
  student_id uuid NOT NULL,
  last_edited_by_user_id uuid NOT NULL,
  graded_by_user_id uuid,
  published_by_user_id uuid,
  status app.exam_result_status NOT NULL DEFAULT 'pending',
  score numeric(10, 2),
  feedback text,
  graded_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_exam_results_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_exam_results_school_exam_student UNIQUE (school_id, exam_id, student_id),
  CONSTRAINT fk_exam_results_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exam_results_exam FOREIGN KEY (exam_id, school_id)
    REFERENCES app.exams (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exam_results_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exam_results_last_edited_by FOREIGN KEY (last_edited_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exam_results_graded_by FOREIGN KEY (graded_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exam_results_published_by FOREIGN KEY (published_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_exam_results_score CHECK (score IS NULL OR score >= 0),
  CONSTRAINT ck_exam_results_feedback CHECK (
    feedback IS NULL OR (feedback = btrim(feedback) AND feedback <> '')
  ),
  CONSTRAINT ck_exam_results_grading_fields CHECK (
    (score IS NULL AND graded_at IS NULL AND graded_by_user_id IS NULL)
    OR (score IS NOT NULL AND graded_at IS NOT NULL AND graded_by_user_id IS NOT NULL)
  ),
  CONSTRAINT ck_exam_results_publication_fields CHECK (
    (published_at IS NULL AND published_by_user_id IS NULL)
    OR (published_at IS NOT NULL AND published_by_user_id IS NOT NULL)
  ),
  CONSTRAINT ck_exam_results_publication_time CHECK (
    published_at IS NULL OR (graded_at IS NOT NULL AND published_at >= graded_at)
  ),
  CONSTRAINT ck_exam_results_lifecycle CHECK (
    (status = 'pending' AND score IS NULL AND published_at IS NULL)
    OR (status IN ('graded', 'withheld') AND score IS NOT NULL AND published_at IS NULL)
    OR (status = 'published' AND score IS NOT NULL AND published_at IS NOT NULL)
    OR (status = 'voided' AND published_at IS NULL)
  ),
  CONSTRAINT ck_exam_results_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.materials (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_materials PRIMARY KEY,
  school_id uuid NOT NULL,
  class_id uuid NOT NULL,
  uploaded_by_user_id uuid NOT NULL,
  last_edited_by_user_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  storage_key text NOT NULL,
  original_file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  checksum_sha256 text,
  ai_visible boolean NOT NULL DEFAULT false,
  ingest_status app.material_ingest_status NOT NULL DEFAULT 'uploaded',
  ingest_error text,
  ingested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_materials_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_materials_storage_key UNIQUE (storage_key),
  CONSTRAINT fk_materials_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_materials_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_materials_uploaded_by FOREIGN KEY (uploaded_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_materials_last_edited_by FOREIGN KEY (last_edited_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_materials_title CHECK (title = btrim(title) AND title <> ''),
  CONSTRAINT ck_materials_description CHECK (
    description IS NULL OR (description = btrim(description) AND description <> '')
  ),
  CONSTRAINT ck_materials_storage_key CHECK (
    storage_key = btrim(storage_key)
    AND storage_key ~ ('^permanent/' || school_id::text || '/[^/]+/[^/]+$')
  ),
  CONSTRAINT ck_materials_original_file_name CHECK (
    original_file_name = btrim(original_file_name) AND original_file_name <> ''
    AND original_file_name !~ '[/\\]'
  ),
  CONSTRAINT ck_materials_mime_type CHECK (
    mime_type = btrim(mime_type) AND mime_type ~ '^[^/[:space:]]+/[^/[:space:]]+$'
  ),
  CONSTRAINT ck_materials_size CHECK (size_bytes > 0),
  CONSTRAINT ck_materials_checksum CHECK (
    checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_materials_ingest_error CHECK (
    ingest_error IS NULL OR (ingest_error = btrim(ingest_error) AND ingest_error <> '')
  ),
  CONSTRAINT ck_materials_ingest_lifecycle CHECK (
    (ingest_status IN ('uploaded', 'processing')
      AND ingest_error IS NULL AND ingested_at IS NULL)
    OR (ingest_status = 'ready' AND ingest_error IS NULL AND ingested_at IS NOT NULL)
    OR (ingest_status = 'failed' AND ingest_error IS NOT NULL AND ingested_at IS NULL)
  ),
  CONSTRAINT ck_materials_timestamps CHECK (updated_at >= created_at)
);

-- Tenant-leading indexes serve established list/queue queries, back composite foreign keys, and
-- remain compatible with school_id = current_setting('app.school_id')::uuid.
CREATE INDEX idx_assignments_school_class_due_at
  ON app.assignments (school_id, class_id, due_at, id);
CREATE INDEX idx_assignments_school_created_by
  ON app.assignments (school_id, created_by_user_id, id);
CREATE INDEX idx_assignments_school_last_edited_by
  ON app.assignments (school_id, last_edited_by_user_id, id);

CREATE INDEX idx_assignment_submissions_school_student_assignment
  ON app.assignment_submissions (school_id, student_id, assignment_id);
CREATE INDEX idx_assignment_submissions_school_status_submitted_at
  ON app.assignment_submissions (school_id, status, submitted_at, id);
CREATE INDEX idx_assignment_submissions_school_last_edited_by
  ON app.assignment_submissions (school_id, last_edited_by_user_id, id);
CREATE INDEX idx_assignment_submissions_school_graded_by
  ON app.assignment_submissions (school_id, graded_by_user_id, id);

CREATE INDEX idx_exams_school_class_starts_at ON app.exams (school_id, class_id, starts_at, id);
CREATE INDEX idx_exams_school_created_by ON app.exams (school_id, created_by_user_id, id);
CREATE INDEX idx_exams_school_last_edited_by ON app.exams (school_id, last_edited_by_user_id, id);

CREATE INDEX idx_exam_results_school_student_exam
  ON app.exam_results (school_id, student_id, exam_id);
CREATE INDEX idx_exam_results_school_last_edited_by
  ON app.exam_results (school_id, last_edited_by_user_id, id);
CREATE INDEX idx_exam_results_school_graded_by
  ON app.exam_results (school_id, graded_by_user_id, id);
CREATE INDEX idx_exam_results_school_published_by
  ON app.exam_results (school_id, published_by_user_id, id);

CREATE INDEX idx_materials_school_class_created_at
  ON app.materials (school_id, class_id, created_at, id);
CREATE INDEX idx_materials_school_ingest_status_created_at
  ON app.materials (school_id, ingest_status, created_at, id);
CREATE INDEX idx_materials_school_uploaded_by
  ON app.materials (school_id, uploaded_by_user_id, id);
CREATE INDEX idx_materials_school_last_edited_by
  ON app.materials (school_id, last_edited_by_user_id, id);

REVOKE ALL PRIVILEGES ON TABLE
  app.assignments, app.assignment_submissions, app.exams, app.exam_results, app.materials
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.assignments, app.assignment_submissions, app.exams, app.exam_results, app.materials
TO studafy_app;

REVOKE ALL ON TYPE
  app.assignment_status, app.assignment_submission_status, app.exam_status,
  app.exam_result_status, app.material_ingest_status
FROM PUBLIC;
GRANT USAGE ON TYPE
  app.assignment_status, app.assignment_submission_status, app.exam_status,
  app.exam_result_status, app.material_ingest_status
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'assignments');
SELECT app.apply_tenant_isolation('app', 'assignment_submissions');
SELECT app.apply_tenant_isolation('app', 'exams');
SELECT app.apply_tenant_isolation('app', 'exam_results');
SELECT app.apply_tenant_isolation('app', 'materials');

RESET ROLE;
