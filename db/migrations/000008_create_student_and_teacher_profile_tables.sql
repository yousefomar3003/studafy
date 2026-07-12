-- Normalized school-owned student, teacher, and parent/child profiles with structural tenant
-- integrity and canonical forced row-level security.

SET ROLE studafy_admin;

CREATE TYPE app.student_status AS ENUM (
  'applicant', 'enrolled', 'suspended', 'graduated', 'withdrawn', 'archived'
);
CREATE TYPE app.teacher_employment_status AS ENUM (
  'pending', 'active', 'on_leave', 'suspended', 'terminated', 'archived'
);
CREATE TYPE app.parent_relationship AS ENUM (
  'mother', 'father', 'guardian', 'step_parent', 'grandparent', 'sibling', 'other'
);

CREATE TABLE app.students (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_students PRIMARY KEY,
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  admission_number text NOT NULL,
  normalized_admission_number text
    GENERATED ALWAYS AS (lower(btrim(admission_number))) STORED,
  first_name text NOT NULL,
  middle_name text,
  last_name text NOT NULL,
  preferred_name text,
  date_of_birth date,
  nationality_country_id uuid,
  admission_date date,
  status app.student_status NOT NULL DEFAULT 'applicant',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_students_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_students_school_user UNIQUE (school_id, user_id),
  CONSTRAINT uq_students_school_normalized_admission_number
    UNIQUE (school_id, normalized_admission_number),
  CONSTRAINT fk_students_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_students_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_students_nationality_country FOREIGN KEY (nationality_country_id)
    REFERENCES app.countries (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_students_admission_number CHECK (
    admission_number = btrim(admission_number) AND admission_number <> ''
  ),
  CONSTRAINT ck_students_first_name CHECK (
    first_name = btrim(first_name) AND first_name <> ''
  ),
  CONSTRAINT ck_students_middle_name CHECK (
    middle_name IS NULL OR (middle_name = btrim(middle_name) AND middle_name <> '')
  ),
  CONSTRAINT ck_students_last_name CHECK (
    last_name = btrim(last_name) AND last_name <> ''
  ),
  CONSTRAINT ck_students_preferred_name CHECK (
    preferred_name IS NULL OR (preferred_name = btrim(preferred_name) AND preferred_name <> '')
  ),
  CONSTRAINT ck_students_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.teachers (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_teachers PRIMARY KEY,
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  employee_number text NOT NULL,
  normalized_employee_number text
    GENERATED ALWAYS AS (lower(btrim(employee_number))) STORED,
  employment_status app.teacher_employment_status NOT NULL DEFAULT 'pending',
  hire_date date,
  termination_date date,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_teachers_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_teachers_school_user UNIQUE (school_id, user_id),
  CONSTRAINT uq_teachers_school_normalized_employee_number
    UNIQUE (school_id, normalized_employee_number),
  CONSTRAINT fk_teachers_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_teachers_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_teachers_employee_number CHECK (
    employee_number = btrim(employee_number) AND employee_number <> ''
  ),
  CONSTRAINT ck_teachers_termination_date CHECK (
    termination_date IS NULL OR (hire_date IS NOT NULL AND termination_date >= hire_date)
  ),
  CONSTRAINT ck_teachers_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.parent_child_links (
  school_id uuid NOT NULL,
  parent_user_id uuid NOT NULL,
  student_id uuid NOT NULL,
  relationship app.parent_relationship NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_parent_child_links PRIMARY KEY (school_id, parent_user_id, student_id),
  CONSTRAINT fk_parent_child_links_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_parent_child_links_parent_user FOREIGN KEY (parent_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_parent_child_links_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_parent_child_links_timestamps CHECK (updated_at >= created_at)
);

-- All other planned access paths are already covered by primary/unique constraint indexes.
CREATE INDEX idx_parent_child_links_school_student_parent
  ON app.parent_child_links (school_id, student_id, parent_user_id);
CREATE INDEX idx_students_nationality_country_id ON app.students (nationality_country_id);

REVOKE ALL PRIVILEGES ON TABLE app.students, app.teachers, app.parent_child_links FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.students, app.teachers, app.parent_child_links TO studafy_app;
REVOKE ALL ON TYPE
  app.student_status, app.teacher_employment_status, app.parent_relationship FROM PUBLIC;
GRANT USAGE ON TYPE
  app.student_status, app.teacher_employment_status, app.parent_relationship TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'students');
SELECT app.apply_tenant_isolation('app', 'teachers');
SELECT app.apply_tenant_isolation('app', 'parent_child_links');

RESET ROLE;
