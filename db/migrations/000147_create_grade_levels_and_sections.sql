-- Grades and sections: the "Grade 10 - Section C" a timetable is built for.
--
-- Until now a class (000009) was one course offering with nothing tying it to a year group, so a
-- timetable could only be filtered class by class. This adds:
--
--   * app.grade_levels   -- the school's year groups ("Grade 10"), ordered by sort_order. A catalog,
--                           like subjects: it outlives any one academic year.
--   * app.sections       -- one group of students within a grade for one academic year ("C").
--   * app.classes.section_id -- the section a class is taught to. Nullable: existing classes, and
--                           electives that mix sections, have none.
--   * app.student_sections -- the one section a student sits in for an academic year.
--
-- A section's timetable is therefore every slot whose class carries its section_id; a student's is
-- still the slots of the classes they are enrolled in (the API enrolls a placed student into their
-- section's classes, so the two agree without a second visibility path).
--
-- INTEGRITY.
-- Every reference is composite with school_id, as in 000009. Sections are additionally keyed by
-- (id, academic_year_id, school_id) so a class and a placement can only point at a section of their
-- own academic year -- the same pinning fk_classes_term uses for terms. app.classes.section_id is
-- nullable, and composite foreign keys are MATCH SIMPLE, so a class without a section is unchecked.
--
-- VISIBILITY.
-- Grade levels and sections are names, not personal data: tenant isolation only, like rooms and
-- terms, so a student's or teacher's app can label a lesson "10-C". A placement says which students
-- are in which section, so app.student_sections reads exactly as app.students does
-- (app.can_read_student_for_attendance, 000133).

-- app.classes already has forced RLS. Its new section_id column is nullable, so every existing row
-- satisfies fk_classes_section; a non-matching tenant context lets the validation scan run without
-- weakening RLS or leaving the constraint NOT VALID (the same approach as 000053).
SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.grade_levels (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grade_levels PRIMARY KEY,
  school_id uuid NOT NULL,
  name text NOT NULL,
  sort_order smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_grade_levels_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_grade_levels_school_name UNIQUE (school_id, name),
  CONSTRAINT fk_grade_levels_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_grade_levels_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_grade_levels_sort_order CHECK (sort_order >= 0),
  CONSTRAINT ck_grade_levels_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.sections (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_sections PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  grade_level_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_sections_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_sections_id_academic_year_school UNIQUE (id, academic_year_id, school_id),
  CONSTRAINT uq_sections_school_year_grade_name
    UNIQUE (school_id, academic_year_id, grade_level_id, name),
  CONSTRAINT fk_sections_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sections_academic_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sections_grade_level FOREIGN KEY (grade_level_id, school_id)
    REFERENCES app.grade_levels (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_sections_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_sections_timestamps CHECK (updated_at >= created_at)
);

ALTER TABLE app.classes
  ADD COLUMN section_id uuid,
  ADD CONSTRAINT fk_classes_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE TABLE app.student_sections (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_sections PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  section_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- One section per student per year; moving a student updates this row.
  CONSTRAINT uq_student_sections_school_student_year
    UNIQUE (school_id, student_id, academic_year_id),
  CONSTRAINT fk_student_sections_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_sections_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_sections_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_sections_timestamps CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------------------------------
-- 2. Indexes (each backs a composite foreign key and the query named beside it)
-- ---------------------------------------------------------------------------------------------------

-- A grade's sections for a year (the builder's Section picker).
CREATE INDEX idx_sections_school_grade_level_year
  ON app.sections (school_id, grade_level_id, academic_year_id);
CREATE INDEX idx_sections_school_academic_year_id ON app.sections (school_id, academic_year_id, id);
-- A section's classes (its timetable, and enrolling a newly placed student).
CREATE INDEX idx_classes_school_section_id ON app.classes (school_id, section_id)
  WHERE section_id IS NOT NULL;
-- A section's students.
CREATE INDEX idx_student_sections_school_section_id
  ON app.student_sections (school_id, section_id, student_id);
CREATE INDEX idx_student_sections_section_fk
  ON app.student_sections (section_id, academic_year_id, school_id);

COMMENT ON TABLE app.grade_levels IS
  'A school''s year groups (000147), e.g. "Grade 10"; ordered by sort_order.';
COMMENT ON TABLE app.sections IS
  'One section of a grade for one academic year (000147), e.g. Grade 10 "C". Classes and student placements reference it.';
COMMENT ON TABLE app.student_sections IS
  'The section a student is placed in for an academic year (000147); at most one per student per year.';
COMMENT ON COLUMN app.classes.section_id IS
  'The section this class is taught to (000147); NULL for a class not tied to one section.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.grade_levels, app.sections, app.student_sections
  FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.grade_levels, app.sections, app.student_sections
  TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'grade_levels');
SELECT app.apply_tenant_isolation('app', 'sections');
SELECT app.apply_tenant_isolation('app', 'student_sections');

CREATE POLICY role_scope_visibility ON app.student_sections
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student_for_attendance(student_id));

RESET ROLE;
