-- Grading: class rank and percentile (American transcripts; the top students, "الأوائل", of
-- Jordanian and Egyptian schools).
--
-- Each grade program (one grade in one year) may rank its students:
--
--   rank_enabled     off by default: a school that does not rank sees nothing new.
--   rank_basis       what students are ranked by: average (the overall average percentage), gpa or
--                    weighted_gpa. A GPA basis needs the grade's result shown as a GPA; students
--                    without a boosted subject are ranked on weighted_gpa by their plain GPA.
--   rank_scope       who a student is ranked against: their section, or every section of the grade
--                    level. A grade-level rank exists only once every section of the grade is
--                    finalized for the period; until then it is reported as pending.
--   rank_visibility  who sees it: staff only, or also students and their parents (in the app and
--                    on the report cards, certificates and transcripts issued to them).
--
-- Rank is not stored on results. It is computed when read from the current (not superseded)
-- finalized results of the period, which change only through audited corrections; an issued
-- document keeps the rank it was issued with in its immutable content.
--
-- A student's rank depends on their classmates' results, which RLS keeps from the student and
-- their parents. app.class_rank_cohort reads one cohort for the API to rank (the rules live in
-- @studafy/grading-engine): every section in scope, whether it must be finalized before a
-- grade-level rank exists (not archived, has students), its current finalization of the period
-- and that finalization's overall results. It returns nothing unless the grade ranks and the
-- caller is school leadership or the rank is visible to students and parents, and it names only
-- the students whose results the caller may read (app.can_read_student_result): a student sees
-- their own row and anonymous values, never a classmate's identity. It uses the existing indexes:
-- uq_sections_school_year_grade_name, uq_result_finalizations_current_term / _current_annual and
-- uq_student_overall_results_finalization_student.
--
-- Expand only: NOT NULL columns with defaults and a new function; no existing row changes meaning.

SET ROLE studafy_admin;

ALTER TABLE app.grade_programs
  ADD COLUMN rank_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN rank_basis text NOT NULL DEFAULT 'average',
  ADD COLUMN rank_scope text NOT NULL DEFAULT 'section',
  ADD COLUMN rank_visibility text NOT NULL DEFAULT 'staff',
  ADD CONSTRAINT ck_grade_programs_rank_basis
    CHECK (rank_basis IN ('average', 'gpa', 'weighted_gpa')),
  ADD CONSTRAINT ck_grade_programs_rank_scope CHECK (rank_scope IN ('section', 'grade_level')),
  ADD CONSTRAINT ck_grade_programs_rank_visibility
    CHECK (rank_visibility IN ('staff', 'students_and_parents')),
  -- Only a GPA result has GPA values to rank by (the API refuses this with a clear message first).
  ADD CONSTRAINT ck_grade_programs_rank_gpa_basis
    CHECK (NOT rank_enabled OR rank_basis = 'average' OR result_format = 'gpa');

COMMENT ON COLUMN app.grade_programs.rank_enabled IS
  'Whether the grade''s students get a class rank and percentile on their finalized results; false by default.';
COMMENT ON COLUMN app.grade_programs.rank_basis IS
  'What students are ranked by: average (overall average percentage), gpa or weighted_gpa (the plain GPA for a student without boosted subjects). gpa and weighted_gpa need result_format gpa.';
COMMENT ON COLUMN app.grade_programs.rank_scope IS
  'Who a student is ranked against: section, or grade_level (every section of the grade; pending until all are finalized for the period).';
COMMENT ON COLUMN app.grade_programs.rank_visibility IS
  'Who sees the rank: staff, or students_and_parents (also in the student and parent app and on the documents issued to them).';

CREATE FUNCTION app.class_rank_cohort(
  target_academic_year_id uuid,
  target_grade_level_id uuid,
  target_term_id uuid,
  target_section_id uuid
)
RETURNS TABLE (
  section_id uuid,
  section_name text,
  section_required boolean,
  finalization_id uuid,
  student_id uuid,
  status text,
  average_percentage numeric,
  result_format text,
  result_value numeric,
  weighted_result_value numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  WITH tenant AS (
    SELECT current_setting('app.school_id')::uuid AS school_id
  ),
  allowed AS (
    SELECT 1
    FROM app.grade_programs AS program
    JOIN tenant ON tenant.school_id = program.school_id
    WHERE program.academic_year_id = target_academic_year_id
      AND program.grade_level_id = target_grade_level_id
      AND program.rank_enabled
      AND (program.rank_visibility = 'students_and_parents' OR app.current_user_is_school_admin())
  ),
  scope AS (
    SELECT section.id, section.name, section.school_id,
           (section.archived_at IS NULL AND EXISTS (
              SELECT 1 FROM app.student_sections AS placement
              WHERE placement.school_id = section.school_id AND placement.section_id = section.id
           )) AS required,
           current_finalization.id AS finalization_id,
           current_finalization.finalized_at
    FROM app.sections AS section
    JOIN tenant ON tenant.school_id = section.school_id
    LEFT JOIN app.result_finalizations AS current_finalization
      ON current_finalization.school_id = section.school_id
     AND current_finalization.section_id = section.id
     AND current_finalization.status = 'finalized'
     AND (
       (target_term_id IS NULL AND current_finalization.term_id IS NULL)
       OR current_finalization.term_id = target_term_id
     )
    WHERE EXISTS (SELECT 1 FROM allowed)
      AND section.academic_year_id = target_academic_year_id
      AND section.grade_level_id = target_grade_level_id
      AND (target_section_id IS NULL OR section.id = target_section_id)
  ),
  results AS (
    -- A student finalized in two sections for the period (they moved) counts once: the later.
    SELECT DISTINCT ON (overall.student_id)
           overall.finalization_id, overall.student_id, overall.status,
           overall.average_percentage, overall.result_format, overall.result_value,
           overall.weighted_result_value
    FROM scope
    JOIN app.student_overall_results AS overall
      ON overall.school_id = scope.school_id AND overall.finalization_id = scope.finalization_id
    ORDER BY overall.student_id, scope.finalized_at DESC, scope.finalization_id DESC
  )
  SELECT scope.id, scope.name, scope.required, scope.finalization_id,
         CASE WHEN app.can_read_student_result(results.student_id, results.finalization_id)
              THEN results.student_id END,
         results.status, results.average_percentage, results.result_format,
         results.result_value, results.weighted_result_value
  FROM scope
  LEFT JOIN results ON results.finalization_id = scope.finalization_id
  ORDER BY scope.name, scope.id
$function$;

COMMENT ON FUNCTION app.class_rank_cohort(uuid, uuid, uuid, uuid) IS
  'One class rank cohort (a section, or every section of a grade level when target_section_id is NULL) for a term or the year (target_term_id NULL): sections, current finalizations and overall results, students named only where the caller may read the result. Empty unless the grade ranks and the caller is leadership or the rank is visible to students and parents.';

ALTER FUNCTION app.class_rank_cohort(uuid, uuid, uuid, uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.class_rank_cohort(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.class_rank_cohort(uuid, uuid, uuid, uuid) TO studafy_app;

RESET ROLE;
