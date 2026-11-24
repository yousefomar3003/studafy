-- IB Diploma total out of 45 (academic phase 2, WS-J).
--
-- A grade program may show its result as the IB Diploma total: result_format 'points_total' with
-- result_scale_max 45. The total is the points (1-7) of the best counted subjects plus core points
-- read from a TOK x Extended Essay bonus matrix; CAS is complete or not; award conditions (minimum
-- total 24, CAS complete, no E in TOK or EE, grade-count and HL/SL point rules) decide whether the
-- diploma is awarded. The rules live in @studafy/grading-engine (diploma.ts).
--
--   app.grade_programs.diploma_config         the grade's matrix and conditions (jsonb, validated by
--                                             the API through the engine). Set while the format is
--                                             points_total, NULL otherwise. The API stores the
--                                             published IB matrix and conditions as an editable
--                                             default; the school checks them against the IB rules.
--   app.grade_programs.rank_basis             gains 'points_total' (rank by the total), allowed only
--                                             on a points_total grade.
--   app.student_overall_results.diploma_result the diploma outcome as finalized (ADR-017): total,
--                                             subject and core points, the TOK/EE/CAS grades used,
--                                             status and failing conditions. NULL for every other
--                                             format and on rows finalized before this migration.
--   app.student_diploma_core_grades           TOK and EE grades (A-E) and CAS completion per student
--                                             and year: one 'final' row (read at finalization, like
--                                             marks) and one 'predicted' row (with phase 1's predicted
--                                             grades it gives a predicted total). History is in
--                                             app.audit_logs, so the table holds the current values.
--
-- PRIVACY. Final core grades are staff data (school leadership, a teacher of the student's section
-- that year), like unreleased marks: students and parents see them only on finalized results.
-- Predicted core grades follow predicted grades (000254): the student and linked parents read them
-- while the grade program shows predicted grades to them (app.can_read_student_predicted_grade).
--
-- Expand only (docs/database/migration-policy.md): CHECKs are replaced with wider ones, columns are
-- nullable, one new table. No existing row changes meaning.
--
-- Depends on 000206 (result formats), 000254 (app.can_read_student_predicted_grade), 000257 (rank
-- settings), 000209 (app.teaches_in_section) and 000037/000120 (role-scope helpers).

SET ROLE studafy_admin;

-- Validating the replaced CHECKs scans app.grade_programs and app.student_overall_results, whose
-- forced RLS applies the tenant_isolation predicate even to the owner (see 000114, 000198, 000210,
-- 000254). Every existing row satisfies the wider constraints by construction, so the nil tenant's
-- empty scan is exact.
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

ALTER TABLE app.grade_programs
  DROP CONSTRAINT ck_grade_programs_result_format,
  DROP CONSTRAINT ck_grade_programs_result_scale_max,
  DROP CONSTRAINT ck_grade_programs_rank_basis,
  DROP CONSTRAINT ck_grade_programs_rank_gpa_basis,
  ADD COLUMN diploma_config jsonb,
  ADD CONSTRAINT ck_grade_programs_result_format
    CHECK (result_format IN ('percentage', 'out_of', 'gpa', 'points_total')),
  ADD CONSTRAINT ck_grade_programs_result_scale_max CHECK (
    (result_format = 'percentage' AND result_scale_max IS NULL)
    OR (result_format = 'out_of' AND result_scale_max > 0 AND result_scale_max <= 1000)
    OR (result_format = 'gpa' AND result_scale_max > 0 AND result_scale_max <= 10)
    OR (result_format = 'points_total' AND result_scale_max > 0 AND result_scale_max <= 1000)
  ),
  ADD CONSTRAINT ck_grade_programs_diploma_config CHECK (
    (result_format = 'points_total' AND jsonb_typeof(diploma_config) = 'object')
    OR (result_format <> 'points_total' AND diploma_config IS NULL)
  ),
  ADD CONSTRAINT ck_grade_programs_rank_basis
    CHECK (rank_basis IN ('average', 'gpa', 'weighted_gpa', 'points_total')),
  -- Only a GPA result has GPA values, and only a points_total result a total, to rank by (the API
  -- refuses both with a clear message first). The constraint keeps its 000257 name.
  ADD CONSTRAINT ck_grade_programs_rank_gpa_basis CHECK (
    NOT rank_enabled
    OR rank_basis = 'average'
    OR (rank_basis IN ('gpa', 'weighted_gpa') AND result_format = 'gpa')
    OR (rank_basis = 'points_total' AND result_format = 'points_total')
  );

COMMENT ON COLUMN app.grade_programs.result_format IS
  'How the final result is shown: percentage (out of 100), out_of (rescaled to result_scale_max), gpa (weighted GPA points out of result_scale_max) or points_total (the IB Diploma total out of result_scale_max, 45).';
COMMENT ON COLUMN app.grade_programs.result_scale_max IS
  'The maximum for out_of (e.g. 20), gpa (4 or 5) or points_total (45); NULL for percentage.';
COMMENT ON COLUMN app.grade_programs.diploma_config IS
  'points_total only: counted subjects, the TOK x EE core points matrix and the award conditions (editable; the IB defaults must be checked against the current IB rules). NULL for other formats (000262).';
COMMENT ON COLUMN app.grade_programs.rank_basis IS
  'What students are ranked by: average (overall average percentage), gpa or weighted_gpa (the plain GPA for a student without boosted subjects), or points_total (the IB Diploma total). gpa and weighted_gpa need result_format gpa; points_total needs result_format points_total.';

ALTER TABLE app.student_overall_results
  DROP CONSTRAINT ck_student_overall_results_result_format,
  ADD COLUMN diploma_result jsonb,
  ADD CONSTRAINT ck_student_overall_results_result_format
    CHECK (result_format IS NULL OR result_format IN ('percentage', 'out_of', 'gpa', 'points_total')),
  ADD CONSTRAINT ck_student_overall_results_diploma_result CHECK (
    diploma_result IS NULL
    OR (result_format = 'points_total' AND jsonb_typeof(diploma_result) = 'object')
  );

COMMENT ON COLUMN app.student_overall_results.diploma_result IS
  'points_total results: the diploma outcome as finalized (total, subject and core points, TOK/EE/CAS used, status, failing conditions). NULL otherwise and before 000262.';

CREATE TABLE app.student_diploma_core_grades (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_diploma_core_grades PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  student_id uuid NOT NULL,
  -- 'final': the grades the diploma total is finalized with. 'predicted': the forecast.
  kind text NOT NULL,
  tok_grade text,
  ee_grade text,
  cas_complete boolean,
  entered_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_student_diploma_core_grades_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_diploma_core_grades_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_diploma_core_grades_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_diploma_core_grades_entered_by FOREIGN KEY (entered_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_diploma_core_grades_kind CHECK (kind IN ('final', 'predicted')),
  CONSTRAINT ck_student_diploma_core_grades_tok
    CHECK (tok_grade IS NULL OR tok_grade IN ('A', 'B', 'C', 'D', 'E')),
  CONSTRAINT ck_student_diploma_core_grades_ee
    CHECK (ee_grade IS NULL OR ee_grade IN ('A', 'B', 'C', 'D', 'E')),
  -- A row with nothing recorded is deleted instead.
  CONSTRAINT ck_student_diploma_core_grades_something
    CHECK (tok_grade IS NOT NULL OR ee_grade IS NOT NULL OR cas_complete IS NOT NULL),
  CONSTRAINT ck_student_diploma_core_grades_timestamps CHECK (updated_at >= created_at)
);

-- One current row per student, year and kind.
CREATE UNIQUE INDEX uq_student_diploma_core_grades_student
  ON app.student_diploma_core_grades (school_id, academic_year_id, student_id, kind);
-- A student's core grades across years (the student overview and the apps).
CREATE INDEX idx_student_diploma_core_grades_school_student
  ON app.student_diploma_core_grades (school_id, student_id);
CREATE INDEX idx_student_diploma_core_grades_year_fk
  ON app.student_diploma_core_grades (academic_year_id, school_id);
CREATE INDEX idx_student_diploma_core_grades_student_fk
  ON app.student_diploma_core_grades (student_id, school_id);
CREATE INDEX idx_student_diploma_core_grades_entered_by_fk
  ON app.student_diploma_core_grades (entered_by_user_id, school_id);

COMMENT ON TABLE app.student_diploma_core_grades IS
  'IB Diploma core per student and year (000262): TOK and Extended Essay grades (A-E) and CAS completion, final or predicted. History is in app.audit_logs.';

-- ---------------------------------------------------------------------------------------------------
-- Who may read core grades
-- ---------------------------------------------------------------------------------------------------

-- Final: school leadership, or a teacher of the section the student is placed in that year.
-- Predicted: whoever may read the student's predicted grades that year (000254), which adds the
-- student and linked parents while the grade shows predicted grades to them.
CREATE FUNCTION app.can_read_student_diploma_core(
  target_student_id uuid,
  target_year_id uuid,
  target_kind text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN target_kind = 'predicted'
      THEN app.can_read_student_predicted_grade(target_student_id, target_year_id)
    ELSE app.current_user_is_school_admin()
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
  END
$function$;

ALTER FUNCTION app.can_read_student_diploma_core(uuid, uuid, text) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.can_read_student_diploma_core(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_student_diploma_core(uuid, uuid, text) TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------------------------------

-- 000002's default privileges grant studafy_app full DML on new tables, so revoke from it as well
-- as PUBLIC before granting exactly what the table needs. Writers are checked by the API (school
-- leadership, or a teacher of the student's section), as for predicted grades.
REVOKE ALL PRIVILEGES ON TABLE app.student_diploma_core_grades FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.student_diploma_core_grades TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'student_diploma_core_grades');

CREATE POLICY role_scope_visibility ON app.student_diploma_core_grades
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student_diploma_core(student_id, academic_year_id, kind));

RESET ROLE;
