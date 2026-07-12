-- Creates the normalized, school-owned academic catalog, delivery, room, and enrollment model.
-- Composite foreign keys enforce tenant integrity independently of canonical forced RLS.

SET ROLE studafy_admin;

CREATE TYPE app.academic_period_status AS ENUM ('planned', 'active', 'closed', 'archived');
CREATE TYPE app.catalog_status AS ENUM ('draft', 'active', 'inactive', 'archived');
CREATE TYPE app.class_status AS ENUM ('planned', 'active', 'completed', 'cancelled');
CREATE TYPE app.enrollment_status AS ENUM (
  'active', 'waitlisted', 'withdrawn', 'completed', 'cancelled'
);
CREATE TYPE app.room_type AS ENUM ('physical', 'virtual');

CREATE TABLE app.academic_years (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_academic_years PRIMARY KEY,
  school_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status app.academic_period_status NOT NULL DEFAULT 'planned',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_academic_years_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_academic_years_school_code UNIQUE (school_id, code),
  CONSTRAINT fk_academic_years_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_academic_years_code CHECK (code = btrim(code) AND code <> ''),
  CONSTRAINT ck_academic_years_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_academic_years_dates CHECK (ends_on > starts_on),
  CONSTRAINT ck_academic_years_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.terms (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_terms PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  sequence_number smallint NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status app.academic_period_status NOT NULL DEFAULT 'planned',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_terms_id_academic_year_school UNIQUE (id, academic_year_id, school_id),
  CONSTRAINT uq_terms_school_academic_year_code UNIQUE (school_id, academic_year_id, code),
  CONSTRAINT uq_terms_school_academic_year_sequence
    UNIQUE (school_id, academic_year_id, sequence_number),
  CONSTRAINT fk_terms_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_terms_academic_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_terms_code CHECK (code = btrim(code) AND code <> ''),
  CONSTRAINT ck_terms_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_terms_sequence_number CHECK (sequence_number > 0),
  CONSTRAINT ck_terms_dates CHECK (ends_on > starts_on),
  CONSTRAINT ck_terms_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.subjects (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_subjects PRIMARY KEY,
  school_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  status app.catalog_status NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_subjects_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_subjects_school_code UNIQUE (school_id, code),
  CONSTRAINT fk_subjects_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_subjects_code CHECK (code = btrim(code) AND code <> ''),
  CONSTRAINT ck_subjects_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_subjects_description CHECK (
    description IS NULL OR (description = btrim(description) AND description <> '')
  ),
  CONSTRAINT ck_subjects_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.courses (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_courses PRIMARY KEY,
  school_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  status app.catalog_status NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_courses_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_courses_school_code UNIQUE (school_id, code),
  CONSTRAINT fk_courses_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_courses_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_courses_code CHECK (code = btrim(code) AND code <> ''),
  CONSTRAINT ck_courses_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_courses_description CHECK (
    description IS NULL OR (description = btrim(description) AND description <> '')
  ),
  CONSTRAINT ck_courses_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.rooms (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_rooms PRIMARY KEY,
  school_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  room_type app.room_type NOT NULL,
  capacity integer,
  building text,
  floor text,
  virtual_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_rooms_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_rooms_school_code UNIQUE (school_id, code),
  CONSTRAINT fk_rooms_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_rooms_code CHECK (code = btrim(code) AND code <> ''),
  CONSTRAINT ck_rooms_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_rooms_capacity CHECK (capacity IS NULL OR capacity > 0),
  CONSTRAINT ck_rooms_building CHECK (
    building IS NULL OR (building = btrim(building) AND building <> '')
  ),
  CONSTRAINT ck_rooms_floor CHECK (floor IS NULL OR (floor = btrim(floor) AND floor <> '')),
  CONSTRAINT ck_rooms_virtual_url CHECK (
    virtual_url IS NULL OR (
      virtual_url = btrim(virtual_url) AND virtual_url ~ '^https://[^[:space:]]+$'
    )
  ),
  CONSTRAINT ck_rooms_location CHECK (
    (room_type = 'physical' AND building IS NOT NULL AND virtual_url IS NULL)
    OR (room_type = 'virtual' AND building IS NULL AND floor IS NULL AND virtual_url IS NOT NULL)
  ),
  CONSTRAINT ck_rooms_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.classes (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_classes PRIMARY KEY,
  school_id uuid NOT NULL,
  course_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  term_id uuid NOT NULL,
  lead_teacher_id uuid NOT NULL,
  room_id uuid NOT NULL,
  code text NOT NULL,
  capacity integer,
  status app.class_status NOT NULL DEFAULT 'planned',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_classes_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_classes_school_code UNIQUE (school_id, code),
  CONSTRAINT fk_classes_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_classes_course FOREIGN KEY (course_id, school_id)
    REFERENCES app.courses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_classes_academic_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_classes_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_classes_lead_teacher FOREIGN KEY (lead_teacher_id, school_id)
    REFERENCES app.teachers (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_classes_room FOREIGN KEY (room_id, school_id)
    REFERENCES app.rooms (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_classes_code CHECK (code = btrim(code) AND code <> ''),
  CONSTRAINT ck_classes_capacity CHECK (capacity IS NULL OR capacity > 0),
  CONSTRAINT ck_classes_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.enrollments (
  school_id uuid NOT NULL,
  class_id uuid NOT NULL,
  student_id uuid NOT NULL,
  status app.enrollment_status NOT NULL DEFAULT 'active',
  enrolled_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_enrollments PRIMARY KEY (school_id, class_id, student_id),
  CONSTRAINT fk_enrollments_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_enrollments_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_enrollments_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_enrollments_withdrawal_time CHECK (
    withdrawn_at IS NULL OR withdrawn_at >= enrolled_at
  ),
  CONSTRAINT ck_enrollments_withdrawal_status CHECK (
    (status = 'withdrawn' AND withdrawn_at IS NOT NULL)
    OR (status <> 'withdrawn' AND withdrawn_at IS NULL)
  ),
  CONSTRAINT ck_enrollments_timestamps CHECK (updated_at >= created_at)
);

CREATE FUNCTION app.enforce_term_within_academic_year()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  year_starts_on date;
  year_ends_on date;
BEGIN
  SELECT starts_on, ends_on
  INTO year_starts_on, year_ends_on
  FROM app.academic_years
  WHERE id = NEW.academic_year_id AND school_id = NEW.school_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'academic year % does not belong to school %',
      NEW.academic_year_id, NEW.school_id USING ERRCODE = '23503';
  END IF;

  IF NEW.starts_on < year_starts_on OR NEW.ends_on > year_ends_on THEN
    RAISE EXCEPTION 'term dates [% - %] must be within academic year dates [% - %]',
      NEW.starts_on, NEW.ends_on, year_starts_on, year_ends_on USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE FUNCTION app.prevent_academic_year_term_date_violation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app.terms
    WHERE academic_year_id = NEW.id
      AND school_id = NEW.school_id
      AND (starts_on < NEW.starts_on OR ends_on > NEW.ends_on)
  ) THEN
    RAISE EXCEPTION 'academic year date change would place an existing term outside its bounds'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_terms_within_academic_year
BEFORE INSERT OR UPDATE OF school_id, academic_year_id, starts_on, ends_on ON app.terms
FOR EACH ROW EXECUTE FUNCTION app.enforce_term_within_academic_year();

CREATE TRIGGER trg_academic_years_preserve_term_dates
BEFORE UPDATE OF school_id, starts_on, ends_on ON app.academic_years
FOR EACH ROW EXECUTE FUNCTION app.prevent_academic_year_term_date_violation();

ALTER FUNCTION app.enforce_term_within_academic_year() OWNER TO studafy_admin;
ALTER FUNCTION app.prevent_academic_year_term_date_violation() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.enforce_term_within_academic_year() FROM PUBLIC, studafy_app;
REVOKE ALL ON FUNCTION app.prevent_academic_year_term_date_violation() FROM PUBLIC, studafy_app;

CREATE UNIQUE INDEX uq_academic_years_one_active_per_school
  ON app.academic_years (school_id) WHERE status = 'active';
CREATE INDEX idx_courses_school_subject_id ON app.courses (school_id, subject_id, id);
CREATE INDEX idx_classes_school_academic_year_id
  ON app.classes (school_id, academic_year_id, id);
CREATE INDEX idx_classes_school_term_id ON app.classes (school_id, term_id, id);
CREATE INDEX idx_classes_school_course_id ON app.classes (school_id, course_id, id);
CREATE INDEX idx_classes_school_lead_teacher_id
  ON app.classes (school_id, lead_teacher_id, id);
CREATE INDEX idx_classes_school_room_id ON app.classes (school_id, room_id, id);
CREATE INDEX idx_enrollments_school_student_class
  ON app.enrollments (school_id, student_id, class_id);

REVOKE ALL PRIVILEGES ON TABLE
  app.academic_years, app.terms, app.subjects, app.courses,
  app.rooms, app.classes, app.enrollments
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.academic_years, app.terms, app.subjects, app.courses,
  app.rooms, app.classes, app.enrollments
TO studafy_app;

REVOKE ALL ON TYPE
  app.academic_period_status, app.catalog_status, app.class_status,
  app.enrollment_status, app.room_type
FROM PUBLIC;
GRANT USAGE ON TYPE
  app.academic_period_status, app.catalog_status, app.class_status,
  app.enrollment_status, app.room_type
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'academic_years');
SELECT app.apply_tenant_isolation('app', 'terms');
SELECT app.apply_tenant_isolation('app', 'subjects');
SELECT app.apply_tenant_isolation('app', 'courses');
SELECT app.apply_tenant_isolation('app', 'rooms');
SELECT app.apply_tenant_isolation('app', 'classes');
SELECT app.apply_tenant_isolation('app', 'enrollments');

RESET ROLE;
