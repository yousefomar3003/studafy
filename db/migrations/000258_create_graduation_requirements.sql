-- Graduation requirements checker (docs/plans/curriculum-support.md, WS-F): the rules a student must
-- meet to graduate (an American diploma's credits, a minimum GPA, required subjects, a national or
-- admissions exam), and whether each student meets them.
--
-- SETS. app.graduation_requirement_sets is one named set of rules ("High school diploma") that
-- applies to the grade levels listed in app.graduation_requirement_set_grade_levels, optionally only
-- from one academic year on (students in that year or a later one). An inactive set applies to
-- nobody. Students and their parents see their own checklist for a set only when
-- visible_to_students_and_parents is on; staff always do.
--
-- RULES. app.graduation_requirements holds a set's rules in display order, each of one type:
--   total_credits       credits earned >= min_value
--   group_credits       credits earned in a named group of subjects >= min_value ("English": 4)
--   subjects_passed     every subject of a named group passed
--   cumulative_gpa      the transcript's cumulative GPA >= min_value
--   cumulative_average  the transcript's cumulative average >= min_value (a percentage)
--   external_exam       a result recorded for an external exam (000255), with a total of at least
--                       min_value when one is set
-- Subjects have no group of their own, so a rule names its group (group_name) and lists the
-- subjects in it (app.graduation_requirement_subjects).
--
-- EVALUATION is pure (packages/grading-engine, graduation.ts) and done on read from the rows an
-- academic transcript reads -- every academic year's current, finalized annual result -- and the
-- student's external exam results. Nothing is stored per student: results change only through
-- audited corrections. A transcript copies the outcome into its content when issued (000207
-- transcripts stay immutable).
--
-- VISIBILITY. Sets and rules are configuration, not personal data: tenant isolation only. The
-- subjects a rule names are read through app.graduation_requirement_subject_names, because
-- app.subjects is role-scoped (000037) and would hide from a student a required subject they have
-- not taken yet.
--
-- Depends on 000006 (tenant helpers), 000009 (academic years, subjects), 000147 (grade levels) and
-- 000255 (external exams).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Sets and the grade levels they apply to
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.graduation_requirement_sets (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_graduation_requirement_sets PRIMARY KEY,
  school_id uuid NOT NULL,
  name text NOT NULL,
  -- Applies to students in this academic year or a later one; NULL: every year.
  applies_from_academic_year_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  visible_to_students_and_parents boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_graduation_requirement_sets_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_graduation_requirement_sets_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_graduation_requirement_sets_from_year
    FOREIGN KEY (applies_from_academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_graduation_requirement_sets_name CHECK (
    name = btrim(name) AND name <> '' AND char_length(name) <= 120
  ),
  CONSTRAINT ck_graduation_requirement_sets_timestamps CHECK (updated_at >= created_at)
);

-- Names are unique within a school, whatever their case.
CREATE UNIQUE INDEX uq_graduation_requirement_sets_school_name
  ON app.graduation_requirement_sets (school_id, lower(name));
-- The sets as listed (by name); also the plain school_id-leading index the RLS path needs.
CREATE INDEX idx_graduation_requirement_sets_school_name
  ON app.graduation_requirement_sets (school_id, name);
CREATE INDEX idx_graduation_requirement_sets_from_year_fk
  ON app.graduation_requirement_sets (applies_from_academic_year_id, school_id)
  WHERE applies_from_academic_year_id IS NOT NULL;

CREATE TABLE app.graduation_requirement_set_grade_levels (
  school_id uuid NOT NULL,
  set_id uuid NOT NULL,
  grade_level_id uuid NOT NULL,
  CONSTRAINT pk_graduation_requirement_set_grade_levels
    PRIMARY KEY (school_id, set_id, grade_level_id),
  CONSTRAINT fk_graduation_requirement_set_grade_levels_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Deleting a set deletes its grade levels with it.
  CONSTRAINT fk_graduation_requirement_set_grade_levels_set FOREIGN KEY (set_id, school_id)
    REFERENCES app.graduation_requirement_sets (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_graduation_requirement_set_grade_levels_grade FOREIGN KEY (grade_level_id, school_id)
    REFERENCES app.grade_levels (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- The primary key's (school_id, set_id, ...) prefix does not serve the (set_id, school_id) and
-- (grade_level_id, school_id) foreign keys; "which sets apply to this grade" reads by the latter.
CREATE INDEX idx_graduation_requirement_set_grade_levels_set_fk
  ON app.graduation_requirement_set_grade_levels (set_id, school_id);
CREATE INDEX idx_graduation_requirement_set_grade_levels_grade_fk
  ON app.graduation_requirement_set_grade_levels (grade_level_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 2. Rules and the subjects a rule names
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.graduation_requirements (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_graduation_requirements PRIMARY KEY,
  school_id uuid NOT NULL,
  set_id uuid NOT NULL,
  rule_type text NOT NULL,
  -- Credits, a GPA, an average percentage or an exam's minimum total (see the rule types above).
  min_value numeric(8, 2),
  group_name text,
  external_exam_id uuid,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_graduation_requirements_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_graduation_requirements_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Deleting a set deletes its rules with it.
  CONSTRAINT fk_graduation_requirements_set FOREIGN KEY (set_id, school_id)
    REFERENCES app.graduation_requirement_sets (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  -- An exam named by a rule is archived, never deleted (000255).
  CONSTRAINT fk_graduation_requirements_exam FOREIGN KEY (external_exam_id, school_id)
    REFERENCES app.external_exams (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_graduation_requirements_rule_type CHECK (rule_type IN (
    'total_credits', 'group_credits', 'subjects_passed', 'cumulative_gpa', 'cumulative_average',
    'external_exam'
  )),
  -- What each type needs, and nothing else (the API checks the same in the grading engine).
  CONSTRAINT ck_graduation_requirements_min_value CHECK (
    CASE rule_type
      WHEN 'subjects_passed' THEN min_value IS NULL
      WHEN 'external_exam' THEN min_value IS NULL OR min_value > 0
      WHEN 'cumulative_gpa' THEN min_value > 0 AND min_value <= 10
      WHEN 'cumulative_average' THEN min_value > 0 AND min_value <= 100
      ELSE min_value > 0 AND min_value <= 1000
    END
  ),
  CONSTRAINT ck_graduation_requirements_group_name CHECK (
    CASE
      WHEN rule_type IN ('group_credits', 'subjects_passed') THEN
        group_name IS NOT NULL AND group_name = btrim(group_name) AND group_name <> ''
        AND char_length(group_name) <= 120
      ELSE group_name IS NULL
    END
  ),
  CONSTRAINT ck_graduation_requirements_exam CHECK (
    (rule_type = 'external_exam') = (external_exam_id IS NOT NULL)
  ),
  CONSTRAINT ck_graduation_requirements_sort_order CHECK (sort_order >= 0),
  CONSTRAINT ck_graduation_requirements_timestamps CHECK (updated_at >= created_at)
);

-- A set's rules in order: the plain school_id-leading index the RLS path needs, too.
CREATE INDEX idx_graduation_requirements_school_set
  ON app.graduation_requirements (school_id, set_id, sort_order);
CREATE INDEX idx_graduation_requirements_set_fk
  ON app.graduation_requirements (set_id, school_id);
CREATE INDEX idx_graduation_requirements_exam_fk
  ON app.graduation_requirements (external_exam_id, school_id) WHERE external_exam_id IS NOT NULL;

CREATE TABLE app.graduation_requirement_subjects (
  school_id uuid NOT NULL,
  requirement_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  CONSTRAINT pk_graduation_requirement_subjects PRIMARY KEY (school_id, requirement_id, subject_id),
  CONSTRAINT fk_graduation_requirement_subjects_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Deleting a rule (or its set) deletes its subject list with it.
  CONSTRAINT fk_graduation_requirement_subjects_requirement FOREIGN KEY (requirement_id, school_id)
    REFERENCES app.graduation_requirements (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_graduation_requirement_subjects_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_graduation_requirement_subjects_requirement_fk
  ON app.graduation_requirement_subjects (requirement_id, school_id);
CREATE INDEX idx_graduation_requirement_subjects_subject_fk
  ON app.graduation_requirement_subjects (subject_id, school_id);

COMMENT ON TABLE app.graduation_requirement_sets IS
  'A school''s named set of graduation rules, the grade levels it applies to and from which academic year (000258).';
COMMENT ON TABLE app.graduation_requirement_set_grade_levels IS
  'The grade levels a graduation requirement set applies to (000258); deleted with the set.';
COMMENT ON TABLE app.graduation_requirements IS
  'One rule of a graduation requirement set: credits, a subject group, a cumulative GPA or average, or an external exam (000258).';
COMMENT ON TABLE app.graduation_requirement_subjects IS
  'The subjects of a graduation rule''s named subject group (000258); deleted with the rule.';
COMMENT ON COLUMN app.graduation_requirement_sets.visible_to_students_and_parents IS
  'Students and their linked parents see their own checklist for this set in the apps (000258).';

-- ---------------------------------------------------------------------------------------------------
-- 3. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

-- 000002's default privileges grant studafy_app full DML on new tables; take it back from it and
-- PUBLIC, then grant exactly what the API needs. A set is saved whole: its grade levels, rules and
-- their subjects are replaced, so all four tables are deleted from.
REVOKE ALL PRIVILEGES ON TABLE
  app.graduation_requirement_sets, app.graduation_requirement_set_grade_levels,
  app.graduation_requirements, app.graduation_requirement_subjects
FROM PUBLIC, studafy_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.graduation_requirement_sets, app.graduation_requirement_set_grade_levels,
  app.graduation_requirements, app.graduation_requirement_subjects
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'graduation_requirement_sets');
SELECT app.apply_tenant_isolation('app', 'graduation_requirement_set_grade_levels');
SELECT app.apply_tenant_isolation('app', 'graduation_requirements');
SELECT app.apply_tenant_isolation('app', 'graduation_requirement_subjects');

-- The subjects graduation rules name, for anyone who may see the rules: staff, and students and
-- parents for the sets shown to them. app.subjects is role-scoped (000037): a student or parent sees
-- a subject only through a class or a released mark, so a required subject the student has not
-- taken would come back without its name. Like 000255's helper, this reads as its owner -- still
-- under tenant isolation (FORCE, current school only) -- and reveals only a subject's code and name,
-- beside a rule the caller can already read. It deliberately does not widen app.subjects' policy.
CREATE FUNCTION app.graduation_requirement_subject_names(target_set_ids uuid[])
RETURNS TABLE (requirement_id uuid, subject_id uuid, code text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT link.requirement_id, subject.id, subject.code, subject.name
  FROM app.graduation_requirement_subjects AS link
  JOIN app.graduation_requirements AS requirement
    ON requirement.id = link.requirement_id AND requirement.school_id = link.school_id
  JOIN app.graduation_requirement_sets AS requirement_set
    ON requirement_set.id = requirement.set_id AND requirement_set.school_id = requirement.school_id
  JOIN app.subjects AS subject
    ON subject.id = link.subject_id AND subject.school_id = link.school_id
  WHERE link.school_id = current_setting('app.school_id')::uuid
    AND requirement.set_id = ANY (target_set_ids)
    AND (
      requirement_set.visible_to_students_and_parents
      OR app.current_user_is_school_admin()
      OR app.current_user_teacher_id() IS NOT NULL
    )
$function$;

ALTER FUNCTION app.graduation_requirement_subject_names(uuid[]) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.graduation_requirement_subject_names(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.graduation_requirement_subject_names(uuid[]) TO studafy_app;

RESET ROLE;
