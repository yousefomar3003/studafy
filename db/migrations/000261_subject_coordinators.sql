-- Subject coordinators (docs/plans/academic-phase2.md, WS-H): a staff member -- usually a teacher --
-- who coordinates a subject across every section of the grades they cover for one academic year
-- ("head of maths for grades 10-12"). Not a new role (roles are a fixed enum, ADR-002): an
-- assignment on top of the user's existing staff role.
--
--   app.subject_coordinators              one row per (academic year, subject, user).
--   app.subject_coordinator_grade_levels  the grade levels an assignment is limited to. No rows: every
--                                         grade level that is taught the subject that year.
--
-- WHAT A COORDINATOR READS, for their subjects in their grades only, read-only:
--   * every section's raw marks          app.can_read_student_mark gains the coordinator check;
--   * mark sheets and releases           already tenant-wide configuration (000160, 000229);
--   * predicted grades                   app.student_predicted_grades' policy gains an arm;
--   * finalized subject results          app.student_subject_results' policy gains an arm;
--   * the students and placements of     app.students, app.student_sections and
--     those sections, and their choices  app.student_subject_enrollments' policies gain an arm;
--   * the subject itself                 app.can_read_subject gains an arm.
-- Overall results, certificates, report notes, attendance and everything else about a student stay
-- as they were: a coordinator is not the students' teacher. Writing marks, submitting, approving
-- and finalizing are unchanged (the API's checks stay app.teaches_section_subject / leadership).
--
-- HELPERS (SECURITY DEFINER, current school and current user, like 000037's):
--   app.coordinates_subject(subject_id, academic_year_id)        any grade; the API and batch 2
--   app.coordinates_section_subject(section_id, subject_id)      the section's year and grade, and
--                                                               the subject is taught to it
--   app.coordinates_section(section_id)                          any coordinated subject there
--   app.coordinates_student_subject(student_id, subject_id, year) through the student's placement
--   app.coordinates_student(student_id)                          through any coordinated section
--   app.coordinates_result_subject(finalization_id, subject_id)  through the finalized section
--
-- Every CREATE OR REPLACE below keeps the function's latest body (named at each one) and adds one
-- check; CREATE OR REPLACE keeps owner and grants. Policies change with ALTER POLICY, which keeps
-- their name, role and command.
--
-- Additive only (docs/database/migration-policy.md): two new tables, new functions, wider reads.
--
-- Depends on 000009 (years, subjects), 000147 (grade levels, sections, placements), 000160 (subject
-- configs, marks, results), 000171 (app.students' current policy), 000173 (app.can_read_student_mark's
-- current body) and 000254 (app.can_read_subject's current body, predicted grades).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Assignments
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.subject_coordinators (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_subject_coordinators PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_subject_coordinators_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_subject_coordinators_year_subject_user
    UNIQUE (school_id, academic_year_id, subject_id, user_id),
  CONSTRAINT fk_subject_coordinators_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_coordinators_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_coordinators_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_coordinators_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_subject_coordinators_timestamps CHECK (updated_at >= created_at)
);

-- The helpers' lookup: the current user's assignments in a year.
CREATE INDEX idx_subject_coordinators_school_user
  ON app.subject_coordinators (school_id, user_id, academic_year_id);
-- Academic setup lists a year's assignments.
CREATE INDEX idx_subject_coordinators_school_year
  ON app.subject_coordinators (school_id, academic_year_id, subject_id);
CREATE INDEX idx_subject_coordinators_year_fk
  ON app.subject_coordinators (academic_year_id, school_id);
CREATE INDEX idx_subject_coordinators_subject_fk
  ON app.subject_coordinators (subject_id, school_id);
CREATE INDEX idx_subject_coordinators_user_fk
  ON app.subject_coordinators (user_id, school_id);

CREATE TABLE app.subject_coordinator_grade_levels (
  school_id uuid NOT NULL,
  coordinator_id uuid NOT NULL,
  grade_level_id uuid NOT NULL,
  CONSTRAINT pk_subject_coordinator_grade_levels
    PRIMARY KEY (school_id, coordinator_id, grade_level_id),
  CONSTRAINT fk_subject_coordinator_grade_levels_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Removing an assignment removes its grade levels with it.
  CONSTRAINT fk_subject_coordinator_grade_levels_coordinator FOREIGN KEY (coordinator_id, school_id)
    REFERENCES app.subject_coordinators (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_subject_coordinator_grade_levels_grade FOREIGN KEY (grade_level_id, school_id)
    REFERENCES app.grade_levels (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_subject_coordinator_grade_levels_coordinator_fk
  ON app.subject_coordinator_grade_levels (coordinator_id, school_id);
CREATE INDEX idx_subject_coordinator_grade_levels_grade_fk
  ON app.subject_coordinator_grade_levels (grade_level_id, school_id);

COMMENT ON TABLE app.subject_coordinators IS
  'A staff member who coordinates a subject for an academic year: reads every section''s marks, predicted grades and subject results for it (000261).';
COMMENT ON TABLE app.subject_coordinator_grade_levels IS
  'The grade levels a subject coordinator assignment is limited to; none means every grade taught the subject (000261).';

-- Assignments are configuration, like teacher assignments (000160): tenant isolation only, so a
-- teacher's app can show who coordinates a subject.
REVOKE ALL PRIVILEGES ON TABLE app.subject_coordinators, app.subject_coordinator_grade_levels
  FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.subject_coordinators, app.subject_coordinator_grade_levels
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'subject_coordinators');
SELECT app.apply_tenant_isolation('app', 'subject_coordinator_grade_levels');

-- ---------------------------------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------------------------------

-- True when the current user coordinates the subject in the academic year, for any grade level.
-- The parameters keep the plan's names; the body qualifies them so they never read as columns.
CREATE FUNCTION app.coordinates_subject(subject_id uuid, academic_year_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.subject_coordinators AS coordinator
    WHERE coordinator.school_id = current_setting('app.school_id')::uuid
      AND coordinator.user_id = app.scope_user_id()
      AND coordinator.academic_year_id = coordinates_subject.academic_year_id
      AND coordinator.subject_id = coordinates_subject.subject_id
  )
$function$;

-- True when the current user coordinates the subject for the section: an assignment for the
-- section's year that covers its grade level (no grade levels: every grade), and the subject is
-- taught to that grade or section (a subject configuration exists for it).
CREATE FUNCTION app.coordinates_section_subject(target_section_id uuid, target_subject_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.subject_coordinators AS coordinator
    JOIN app.sections AS section
      ON section.school_id = coordinator.school_id
     AND section.academic_year_id = coordinator.academic_year_id
    WHERE coordinator.school_id = current_setting('app.school_id')::uuid
      AND coordinator.user_id = app.scope_user_id()
      AND coordinator.subject_id = target_subject_id
      AND section.id = target_section_id
      AND (
        NOT EXISTS (
          SELECT 1
          FROM app.subject_coordinator_grade_levels AS covered
          WHERE covered.school_id = coordinator.school_id
            AND covered.coordinator_id = coordinator.id
        )
        OR EXISTS (
          SELECT 1
          FROM app.subject_coordinator_grade_levels AS covered
          WHERE covered.school_id = coordinator.school_id
            AND covered.coordinator_id = coordinator.id
            AND covered.grade_level_id = section.grade_level_id
        )
      )
      AND EXISTS (
        SELECT 1
        FROM app.subject_configs AS config
        WHERE config.school_id = section.school_id
          AND config.academic_year_id = section.academic_year_id
          AND config.grade_level_id = section.grade_level_id
          AND config.subject_id = target_subject_id
          AND (config.section_id IS NULL OR config.section_id = section.id)
      )
  )
$function$;

-- True when the current user coordinates any subject taught in the section.
CREATE FUNCTION app.coordinates_section(target_section_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.subject_coordinators AS coordinator
    WHERE coordinator.school_id = current_setting('app.school_id')::uuid
      AND coordinator.user_id = app.scope_user_id()
      AND app.coordinates_section_subject(target_section_id, coordinator.subject_id)
  )
$function$;

-- True when the current user coordinates the subject for the section the student is placed in that
-- year.
CREATE FUNCTION app.coordinates_student_subject(
  target_student_id uuid,
  target_subject_id uuid,
  target_year_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.student_sections AS placement
    WHERE placement.school_id = current_setting('app.school_id')::uuid
      AND placement.student_id = target_student_id
      AND placement.academic_year_id = target_year_id
      AND app.coordinates_section_subject(placement.section_id, target_subject_id)
  )
$function$;

-- True when the student is placed in a section the current user coordinates a subject in. The first
-- EXISTS is the cheap exit for everyone who coordinates nothing.
CREATE FUNCTION app.coordinates_student(target_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
      SELECT 1
      FROM app.subject_coordinators AS coordinator
      WHERE coordinator.school_id = current_setting('app.school_id')::uuid
        AND coordinator.user_id = app.scope_user_id()
    )
    AND EXISTS (
      SELECT 1
      FROM app.student_sections AS placement
      WHERE placement.school_id = current_setting('app.school_id')::uuid
        AND placement.student_id = target_student_id
        AND app.coordinates_section(placement.section_id)
    )
$function$;

-- True when the current user coordinates the subject for the section a finalization belongs to.
CREATE FUNCTION app.coordinates_result_subject(target_finalization_id uuid, target_subject_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.result_finalizations AS finalization
    WHERE finalization.school_id = current_setting('app.school_id')::uuid
      AND finalization.id = target_finalization_id
      AND app.coordinates_section_subject(finalization.section_id, target_subject_id)
  )
$function$;

ALTER FUNCTION app.coordinates_subject(uuid, uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.coordinates_section_subject(uuid, uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.coordinates_section(uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.coordinates_student_subject(uuid, uuid, uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.coordinates_student(uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.coordinates_result_subject(uuid, uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION
  app.coordinates_subject(uuid, uuid),
  app.coordinates_section_subject(uuid, uuid),
  app.coordinates_section(uuid),
  app.coordinates_student_subject(uuid, uuid, uuid),
  app.coordinates_student(uuid),
  app.coordinates_result_subject(uuid, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.coordinates_subject(uuid, uuid),
  app.coordinates_section_subject(uuid, uuid),
  app.coordinates_section(uuid),
  app.coordinates_student_subject(uuid, uuid, uuid),
  app.coordinates_student(uuid),
  app.coordinates_result_subject(uuid, uuid)
TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 3. Wider reads
-- ---------------------------------------------------------------------------------------------------

-- Raw marks: 000173's body; the section-subject check also accepts the subject's coordinator.
CREATE OR REPLACE FUNCTION app.can_read_student_mark(target_student_id uuid, target_assessment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR EXISTS (
      SELECT 1
      FROM app.subject_config_assessments AS assessment
      JOIN app.subject_configs AS config
        ON config.id = assessment.subject_config_id AND config.school_id = assessment.school_id
      JOIN app.student_sections AS placement
        ON placement.student_id = target_student_id
       AND placement.academic_year_id = assessment.academic_year_id
       AND placement.school_id = assessment.school_id
      WHERE assessment.id = target_assessment_id
        AND assessment.school_id = current_setting('app.school_id')::uuid
        AND (
          app.teaches_section_subject(placement.section_id, config.subject_id)
          OR app.coordinates_section_subject(placement.section_id, config.subject_id)
        )
    )
    OR app.is_released_student_mark(target_student_id, target_assessment_id)
$function$;

-- The subject's name: 000254's body with one more arm for its coordinators.
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
    OR EXISTS (
      SELECT 1
      FROM app.subject_coordinators AS coordinator
      WHERE coordinator.subject_id = target_subject_id
        AND coordinator.school_id = current_setting('app.school_id')::uuid
        AND coordinator.user_id = app.scope_user_id()
    )
$function$;

-- Students: 000171's policy, plus the students of the sections the user coordinates a subject in.
ALTER POLICY role_scope_visibility ON app.students
  USING (
    (SELECT app.current_user_is_school_admin())
    OR (SELECT app.current_user_is_attendance_officer())
    OR app.can_read_student_for_attendance(id)
    OR app.coordinates_student(id)
  );

-- Placements: 000147's policy, plus the placements in the sections the user coordinates.
ALTER POLICY role_scope_visibility ON app.student_sections
  USING (app.can_read_student_for_attendance(student_id) OR app.coordinates_section(section_id));

-- Optional and elective choices: 000160's policy, plus the coordinated subject's.
ALTER POLICY role_scope_visibility ON app.student_subject_enrollments
  USING (
    app.can_read_student_for_attendance(student_id)
    OR app.is_related_to_student(student_id)
    OR app.coordinates_student_subject(student_id, subject_id, academic_year_id)
  );

-- Predicted grades: 000254's policy, plus the coordinated subject's.
ALTER POLICY role_scope_visibility ON app.student_predicted_grades
  USING (
    app.can_read_student_predicted_grade(student_id, academic_year_id)
    OR app.coordinates_student_subject(student_id, subject_id, academic_year_id)
  );

-- Finalized subject results: 000160's policy, plus the coordinated subject's. Overall results and
-- certificates are not one subject's and stay as they were.
ALTER POLICY role_scope_visibility ON app.student_subject_results
  USING (
    app.can_read_student_result(student_id, finalization_id)
    OR app.coordinates_result_subject(finalization_id, subject_id)
  );

RESET ROLE;
