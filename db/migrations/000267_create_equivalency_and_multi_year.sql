-- Tawjihi equivalency and multi-year results (docs/plans/academic-phase2.md, WS-N).
--
-- EQUIVALENCY. app.equivalency_rule_sets is one school's rules for ESTIMATING the Jordanian Tawjihi
-- percentage a foreign qualification converts to: IGCSE / A Level grades (000255 external exam
-- results), the IB Diploma total (000263) or an American GPA and SAT. The Ministry's rules change,
-- so the rules are the school's own editable settings and the result is always an estimate the
-- school confirms -- never an official conversion.
--   source_system  the qualification the set is for (igcse_a_level, ib, american, other): a label
--                  for the lists and examples, not a constraint on the parts.
--   parts          an ordered JSON array of weighted parts (exam subjects with a grade -> percentage
--                  table and how many subjects count, the diploma total, the GPA, an exam total,
--                  each with a table or a formula), validated whole by the API through the grading
--                  engine (packages/grading-engine/src/equivalency.ts). Exams and subjects a part
--                  names are checked to belong to the school when the set is saved; exams are
--                  archived, never deleted, and a subject that has gone is reported as missing data.
-- A set applies to the grade levels in app.equivalency_rule_set_grade_levels. Students and their
-- parents see their own estimate only when visible_to_students_and_parents is on; staff always do.
--
-- MULTI-YEAR RESULTS. app.multi_year_result_configs is a weighted result across several grade
-- levels ("Grade 11 40% + Grade 12 60%"), per subject and overall, worked out on read from each
-- year's current finalized annual result (packages/grading-engine/src/multi-year.ts); the weights
-- are in app.multi_year_result_config_years. It is pending while a year is not finalized. Shown to
-- students and parents only when visible_to_students_and_parents is on.
--
-- Nothing is stored per student: both are computed on read from finalized results (which change
-- only through audited corrections) and recorded exam results.
--
-- VISIBILITY. Configuration, not personal data: tenant isolation only. The subjects an equivalency
-- part requires are read through app.equivalency_rule_subject_names, because app.subjects is
-- role-scoped (000037) and would hide a required subject a student has not taken.
--
-- Depends on 000006 (tenant helpers), 000009 (subjects), 000147 (grade levels), 000255 (external
-- exams) and 000263 (IB Diploma total).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Equivalency rule sets and the grade levels they apply to
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.equivalency_rule_sets (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_equivalency_rule_sets PRIMARY KEY,
  school_id uuid NOT NULL,
  name text NOT NULL,
  source_system text NOT NULL,
  parts jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  visible_to_students_and_parents boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_equivalency_rule_sets_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_equivalency_rule_sets_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_equivalency_rule_sets_name CHECK (
    name = btrim(name) AND name <> '' AND char_length(name) <= 120
  ),
  CONSTRAINT ck_equivalency_rule_sets_source_system CHECK (
    source_system IN ('igcse_a_level', 'ib', 'american', 'other')
  ),
  -- 1-6 parts; their contents are validated by the API (grading engine).
  CONSTRAINT ck_equivalency_rule_sets_parts CHECK (
    jsonb_typeof(parts) = 'array' AND jsonb_array_length(parts) BETWEEN 1 AND 6
  ),
  CONSTRAINT ck_equivalency_rule_sets_timestamps CHECK (updated_at >= created_at)
);

-- Names are unique within a school, whatever their case.
CREATE UNIQUE INDEX uq_equivalency_rule_sets_school_name
  ON app.equivalency_rule_sets (school_id, lower(name));
-- The sets as listed (by name); also the plain school_id-leading index the RLS path needs.
CREATE INDEX idx_equivalency_rule_sets_school_name
  ON app.equivalency_rule_sets (school_id, name);

CREATE TABLE app.equivalency_rule_set_grade_levels (
  school_id uuid NOT NULL,
  set_id uuid NOT NULL,
  grade_level_id uuid NOT NULL,
  CONSTRAINT pk_equivalency_rule_set_grade_levels PRIMARY KEY (school_id, set_id, grade_level_id),
  CONSTRAINT fk_equivalency_rule_set_grade_levels_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Deleting a set deletes its grade levels with it.
  CONSTRAINT fk_equivalency_rule_set_grade_levels_set FOREIGN KEY (set_id, school_id)
    REFERENCES app.equivalency_rule_sets (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_equivalency_rule_set_grade_levels_grade FOREIGN KEY (grade_level_id, school_id)
    REFERENCES app.grade_levels (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_equivalency_rule_set_grade_levels_set_fk
  ON app.equivalency_rule_set_grade_levels (set_id, school_id);
CREATE INDEX idx_equivalency_rule_set_grade_levels_grade_fk
  ON app.equivalency_rule_set_grade_levels (grade_level_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 2. Multi-year result configurations and their weighted grade levels
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.multi_year_result_configs (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_multi_year_result_configs PRIMARY KEY,
  school_id uuid NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  visible_to_students_and_parents boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_multi_year_result_configs_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_multi_year_result_configs_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_multi_year_result_configs_name CHECK (
    name = btrim(name) AND name <> '' AND char_length(name) <= 120
  ),
  CONSTRAINT ck_multi_year_result_configs_timestamps CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX uq_multi_year_result_configs_school_name
  ON app.multi_year_result_configs (school_id, lower(name));
CREATE INDEX idx_multi_year_result_configs_school_name
  ON app.multi_year_result_configs (school_id, name);

CREATE TABLE app.multi_year_result_config_years (
  school_id uuid NOT NULL,
  config_id uuid NOT NULL,
  grade_level_id uuid NOT NULL,
  -- Relative: 40 and 60, or 2 and 3, weigh the same.
  weight numeric(5, 2) NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  CONSTRAINT pk_multi_year_result_config_years PRIMARY KEY (school_id, config_id, grade_level_id),
  CONSTRAINT fk_multi_year_result_config_years_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Deleting a configuration deletes its years with it.
  CONSTRAINT fk_multi_year_result_config_years_config FOREIGN KEY (config_id, school_id)
    REFERENCES app.multi_year_result_configs (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_multi_year_result_config_years_grade FOREIGN KEY (grade_level_id, school_id)
    REFERENCES app.grade_levels (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_multi_year_result_config_years_weight CHECK (weight > 0 AND weight <= 100),
  CONSTRAINT ck_multi_year_result_config_years_sort_order CHECK (sort_order >= 0)
);

CREATE INDEX idx_multi_year_result_config_years_config_fk
  ON app.multi_year_result_config_years (config_id, school_id, sort_order);
CREATE INDEX idx_multi_year_result_config_years_grade_fk
  ON app.multi_year_result_config_years (grade_level_id, school_id);

COMMENT ON TABLE app.equivalency_rule_sets IS
  'A school''s rules for estimating the Tawjihi-equivalent percentage of an IGCSE/A Level, IB or American record (000267). An estimate the school confirms, not an official conversion.';
COMMENT ON COLUMN app.equivalency_rule_sets.parts IS
  'Ordered weighted parts (exam subjects, diploma total, GPA, exam total), validated by the grading engine (000267).';
COMMENT ON TABLE app.equivalency_rule_set_grade_levels IS
  'The grade levels a Tawjihi equivalency rule set applies to (000267); deleted with the set.';
COMMENT ON TABLE app.multi_year_result_configs IS
  'A result weighted across several grade levels'' finalized annual results, per subject and overall (000267).';
COMMENT ON TABLE app.multi_year_result_config_years IS
  'A grade level of a multi-year result and its relative weight (000267); deleted with the configuration.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

-- 000002's default privileges grant studafy_app full DML on new tables; take it back from it and
-- PUBLIC, then grant exactly what the API needs. A set or configuration is saved whole: its grade
-- levels are replaced, so all four tables are deleted from.
REVOKE ALL PRIVILEGES ON TABLE
  app.equivalency_rule_sets, app.equivalency_rule_set_grade_levels,
  app.multi_year_result_configs, app.multi_year_result_config_years
FROM PUBLIC, studafy_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.equivalency_rule_sets, app.equivalency_rule_set_grade_levels,
  app.multi_year_result_configs, app.multi_year_result_config_years
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'equivalency_rule_sets');
SELECT app.apply_tenant_isolation('app', 'equivalency_rule_set_grade_levels');
SELECT app.apply_tenant_isolation('app', 'multi_year_result_configs');
SELECT app.apply_tenant_isolation('app', 'multi_year_result_config_years');

-- The subjects equivalency parts require, for anyone who may see the sets: staff, and students and
-- parents for the sets shown to them. Like 000258's helper, this reads as its owner -- still under
-- tenant isolation (FORCE, current school only) -- and reveals only a subject's code and name beside
-- a rule the caller can already read. It deliberately does not widen app.subjects' policy.
CREATE FUNCTION app.equivalency_rule_subject_names(target_set_ids uuid[])
RETURNS TABLE (subject_id uuid, code text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT DISTINCT subject.id, subject.code, subject.name
  FROM app.equivalency_rule_sets AS rule_set
  CROSS JOIN LATERAL jsonb_array_elements(rule_set.parts) AS part(value)
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE jsonb_typeof(part.value -> 'required_subject_ids')
      WHEN 'array' THEN part.value -> 'required_subject_ids'
      ELSE '[]'::jsonb
    END
  ) AS required(subject_id)
  JOIN app.subjects AS subject
    ON subject.school_id = rule_set.school_id AND subject.id::text = required.subject_id
  WHERE rule_set.school_id = current_setting('app.school_id')::uuid
    AND rule_set.id = ANY (target_set_ids)
    AND (
      rule_set.visible_to_students_and_parents
      OR app.current_user_is_school_admin()
      OR app.current_user_teacher_id() IS NOT NULL
    )
$function$;

ALTER FUNCTION app.equivalency_rule_subject_names(uuid[]) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.equivalency_rule_subject_names(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.equivalency_rule_subject_names(uuid[]) TO studafy_app;

RESET ROLE;
