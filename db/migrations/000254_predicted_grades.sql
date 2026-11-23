-- Predicted grades (IGCSE, A-Level, IB): a teacher's forecast of the grade a student will reach in
-- a subject, for one term or for the year, as sent to universities and used for exam entries.
--
--   app.grade_programs.predicted_grades_enabled     the grade's year opts in; nothing changes for a
--                                                   school that never turns it on. Only an enabled
--                                                   program accepts predicted grades (API rule).
--   app.grade_programs.predicted_grades_visibility  'staff' (default): school leadership and the
--                                                   student's teachers only. 'students_and_parents':
--                                                   the student and their linked parents see them too.
--   app.student_predicted_grades                    one current prediction per student, subject and
--                                                   period (a term, or the year when term_id is NULL),
--                                                   with an optional note and who entered it last.
--                                                   Changes are audited in app.audit_logs (old and new
--                                                   label), so this table holds only the current value.
--
-- The label is free text here (at most 40 characters); the API requires it to be one of the bands of
-- the subject's grade scale when the subject has one, so "A*" or "7" stays the school's own wording.
-- Predictions are not results: finalization, report cards, certificates and transcripts never read
-- them, so ADR-017's snapshots are untouched.
--
-- PRIVACY. A prediction is staff data by default: school leadership, or a teacher of the student's
-- section that year. The student and linked parents read it only while the student's grade program
-- for that year is enabled and set to 'students_and_parents' (app.can_read_student_predicted_grade).
--
-- Additive only (docs/database/migration-policy.md): two columns with defaults and a new table.
-- app.can_read_subject gains one arm so the subject's name comes back with a visible prediction.
--
-- Depends on 000160 (grade programs, terms, subjects, students), 000147 (sections, placements),
-- 000209 (app.teaches_in_section), 000229 (app.can_read_subject's current body) and 000037/000120
-- (role-scope helpers).

SET ROLE studafy_admin;

-- Validating the new CHECK scans app.grade_programs, whose forced RLS applies the tenant_isolation
-- predicate even to the owner (see 000114, 000198, 000210). Every existing row satisfies it by
-- construction (the column defaults to 'staff'), so the nil tenant's empty scan is exact.
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

ALTER TABLE app.grade_programs
  ADD COLUMN predicted_grades_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN predicted_grades_visibility text NOT NULL DEFAULT 'staff',
  ADD CONSTRAINT ck_grade_programs_predicted_grades_visibility
    CHECK (predicted_grades_visibility IN ('staff', 'students_and_parents'));

COMMENT ON COLUMN app.grade_programs.predicted_grades_enabled IS
  'Whether teachers record predicted grades for this grade and year (000254).';
COMMENT ON COLUMN app.grade_programs.predicted_grades_visibility IS
  'Who reads predicted grades: staff, or students_and_parents as well (000254).';

CREATE TABLE app.student_predicted_grades (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_predicted_grades PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  -- NULL: the prediction for the whole year rather than one term.
  term_id uuid,
  student_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  grade_label text NOT NULL,
  note text,
  entered_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_student_predicted_grades_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_predicted_grades_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_predicted_grades_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_predicted_grades_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_predicted_grades_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_predicted_grades_entered_by FOREIGN KEY (entered_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_predicted_grades_label
    CHECK (grade_label = btrim(grade_label) AND grade_label <> '' AND char_length(grade_label) <= 40),
  CONSTRAINT ck_student_predicted_grades_note
    CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 1000)),
  CONSTRAINT ck_student_predicted_grades_timestamps CHECK (updated_at >= created_at)
);

-- One current prediction per student, subject and period: per term, and once for the year.
CREATE UNIQUE INDEX uq_student_predicted_grades_term
  ON app.student_predicted_grades (school_id, academic_year_id, term_id, student_id, subject_id)
  WHERE term_id IS NOT NULL;
CREATE UNIQUE INDEX uq_student_predicted_grades_annual
  ON app.student_predicted_grades (school_id, academic_year_id, student_id, subject_id)
  WHERE term_id IS NULL;
-- A student's predictions across years (the student overview and the mobile apps).
CREATE INDEX idx_student_predicted_grades_school_student
  ON app.student_predicted_grades (school_id, student_id, academic_year_id);
CREATE INDEX idx_student_predicted_grades_year_fk
  ON app.student_predicted_grades (academic_year_id, school_id);
CREATE INDEX idx_student_predicted_grades_term_fk
  ON app.student_predicted_grades (term_id, academic_year_id, school_id) WHERE term_id IS NOT NULL;
CREATE INDEX idx_student_predicted_grades_student_fk
  ON app.student_predicted_grades (student_id, school_id);
CREATE INDEX idx_student_predicted_grades_subject_fk
  ON app.student_predicted_grades (subject_id, school_id);
CREATE INDEX idx_student_predicted_grades_entered_by_fk
  ON app.student_predicted_grades (entered_by_user_id, school_id);

COMMENT ON TABLE app.student_predicted_grades IS
  'A student''s current predicted grade in a subject for a term or the year (000254). History is in app.audit_logs.';

-- ---------------------------------------------------------------------------------------------------
-- Who may read a prediction
-- ---------------------------------------------------------------------------------------------------

-- School leadership; a teacher of the section the student is placed in that year; or the student
-- and their linked parents while that section's grade program has predicted grades enabled and
-- visible to them.
CREATE FUNCTION app.can_read_student_predicted_grade(target_student_id uuid, target_year_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR (
      app.current_user_teacher_id() IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM app.student_sections AS placement
        WHERE placement.school_id = current_setting('app.school_id')::uuid
          AND placement.student_id = target_student_id
          AND placement.academic_year_id = target_year_id
          AND app.teaches_in_section(placement.section_id)
      )
    )
    OR (
      app.is_related_to_student(target_student_id)
      AND EXISTS (
        SELECT 1
        FROM app.student_sections AS placement
        JOIN app.sections AS section
          ON section.id = placement.section_id AND section.school_id = placement.school_id
        JOIN app.grade_programs AS program
          ON program.school_id = section.school_id
         AND program.academic_year_id = section.academic_year_id
         AND program.grade_level_id = section.grade_level_id
        WHERE placement.school_id = current_setting('app.school_id')::uuid
          AND placement.student_id = target_student_id
          AND placement.academic_year_id = target_year_id
          AND program.predicted_grades_enabled
          AND program.predicted_grades_visibility = 'students_and_parents'
      )
    )
$function$;

ALTER FUNCTION app.can_read_student_predicted_grade(uuid, uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.can_read_student_predicted_grade(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_student_predicted_grade(uuid, uuid) TO studafy_app;

-- A subject's name follows its visible predictions, as it follows released marks (000173, 000229):
-- without this arm a student or parent would read their prediction but not which subject it is in.
-- The body is 000229's with one more arm; CREATE OR REPLACE keeps the owner and grants.
CREATE OR REPLACE FUNCTION app.can_read_subject(target_subject_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR EXISTS (
      SELECT 1
      FROM app.courses AS co
      JOIN app.classes AS c ON c.course_id = co.id AND c.school_id = co.school_id
      WHERE co.subject_id = target_subject_id
        AND co.school_id = current_setting('app.school_id')::uuid
        AND app.can_read_class(c.id)
    )
    OR EXISTS (
      SELECT 1
      FROM app.section_subject_teachers AS assignment
      WHERE assignment.subject_id = target_subject_id
        AND assignment.school_id = current_setting('app.school_id')::uuid
        AND assignment.teacher_id = app.current_user_teacher_id()
    )
    OR EXISTS (
      SELECT 1
      FROM app.mark_sheets AS sheet
      JOIN app.student_sections AS placement
        ON placement.section_id = sheet.section_id
       AND placement.academic_year_id = sheet.academic_year_id
       AND placement.school_id = sheet.school_id
      WHERE sheet.subject_id = target_subject_id
        AND sheet.school_id = current_setting('app.school_id')::uuid
        AND sheet.status = 'approved'
        AND app.is_related_to_student(placement.student_id)
    )
    OR EXISTS (
      SELECT 1
      FROM app.assessment_mark_releases AS mark_release
      JOIN app.student_sections AS placement
        ON placement.section_id = mark_release.section_id
       AND placement.academic_year_id = mark_release.academic_year_id
       AND placement.school_id = mark_release.school_id
      WHERE mark_release.subject_id = target_subject_id
        AND mark_release.school_id = current_setting('app.school_id')::uuid
        AND mark_release.status = 'approved'
        AND app.is_related_to_student(placement.student_id)
    )
    OR EXISTS (
      SELECT 1
      FROM app.student_predicted_grades AS prediction
      WHERE prediction.subject_id = target_subject_id
        AND prediction.school_id = current_setting('app.school_id')::uuid
        AND app.is_related_to_student(prediction.student_id)
        AND app.can_read_student_predicted_grade(prediction.student_id, prediction.academic_year_id)
    )
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------------------------------

-- 000002's default privileges grant studafy_app full DML on new tables, so revoke from it as well
-- as PUBLIC before granting exactly what the table needs.
REVOKE ALL PRIVILEGES ON TABLE app.student_predicted_grades FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.student_predicted_grades TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'student_predicted_grades');

CREATE POLICY role_scope_visibility ON app.student_predicted_grades
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student_predicted_grade(student_id, academic_year_id));

RESET ROLE;
