-- Approved marks are released to the student and their parents.
--
-- 000160 kept raw marks staff-only ("students and parents see finalized results, never in-progress
-- marks"). Schools want a term's midterm, final and other assessment marks visible as soon as
-- leadership approves the teacher's mark sheet, not only once the year's results are finalized.
-- An approved sheet is not in progress: it is locked against the teacher (saveMarks refuses it,
-- MARKS_LOCKED), and leadership can only take it back by reopening it to 'returned', which hides it
-- again until the next approval.
--
-- A mark is released when the mark sheet of its period is approved: same section (the student's
-- placement that year), same subject, same term (NULL being the annual period, as in
-- apps/api/src/modules/grading/marks-service.ts `sheetFor`). Only active assessments count, so a
-- teacher's still-proposed or rejected assessment never shows.
--
-- can_read_subject gains the matching arm: a student or parent can read a subject's name once
-- they have released marks in it. Without it a section-graded subject the student has no class
-- for would come back without its name (app.subjects is role-scoped, 000037).
--
-- CREATE OR REPLACE keeps both helpers' owner and grants from 000160.

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

-- The student, or a parent linked to them, holding an approved sheet for this mark's period.
CREATE FUNCTION app.is_released_student_mark(target_student_id uuid, target_assessment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.is_related_to_student(target_student_id)
    AND EXISTS (
      SELECT 1
      FROM app.subject_config_assessments AS assessment
      JOIN app.subject_configs AS config
        ON config.id = assessment.subject_config_id AND config.school_id = assessment.school_id
      JOIN app.student_sections AS placement
        ON placement.student_id = target_student_id
       AND placement.academic_year_id = assessment.academic_year_id
       AND placement.school_id = assessment.school_id
      JOIN app.mark_sheets AS sheet
        ON sheet.school_id = assessment.school_id
       AND sheet.academic_year_id = assessment.academic_year_id
       AND sheet.section_id = placement.section_id
       AND sheet.subject_id = config.subject_id
       AND sheet.term_id IS NOT DISTINCT FROM assessment.term_id
      WHERE assessment.id = target_assessment_id
        AND assessment.school_id = current_setting('app.school_id')::uuid
        AND assessment.status = 'active'
        AND sheet.status = 'approved'
    )
$function$;

ALTER FUNCTION app.is_released_student_mark(uuid, uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.is_released_student_mark(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_released_student_mark(uuid, uuid) TO studafy_app;

-- Raw marks: school leadership, a teacher of that student's section in the assessment's subject,
-- or (released marks only) the student and their parents.
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
        AND app.teaches_section_subject(placement.section_id, config.subject_id)
    )
    OR app.is_released_student_mark(target_student_id, target_assessment_id)
$function$;

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
$function$;

RESET ROLE;
