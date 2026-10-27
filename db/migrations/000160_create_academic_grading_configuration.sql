-- Academic grading configuration: grade-level subject defaults, section overrides, structured
-- assessments, marks, finalized result snapshots and certificates.
--
-- THE HIERARCHY.
--   school -> academic year -> grade program (a grade in one year) -> subject configs
--          -> categories -> assessments -> marks -> finalized results -> certificates
--
-- Everything here is scoped to an academic year, so Grade 8 Mathematics in 2026-2027 and in
-- 2027-2028 are two independent configurations. Nothing in this migration touches the existing
-- class gradebook (000013/000052/000053), which keeps working for class-level grading.
--
-- GRADE DEFAULTS AND SECTION OVERRIDES.
-- A subject config with section_id NULL is the grade's default. Every section of that grade and
-- year inherits it live: there is no copy, so editing the default changes every inheriting section.
-- A section that needs something different gets its own subject config row (section_id set); that
-- row replaces the default for that section only. Overrides remember the default's `revision` they
-- were forked from (`based_on_revision`), so a later change to the default is reported as
-- "default changed since this override" instead of being silently applied or silently lost.
-- `is_excluded` lets a section drop an inherited subject (e.g. an elective it does not offer).
-- An assessment with section_id set is an extra assessment for one section on an inherited config
-- ("8C has an additional practical").
--
-- HISTORY.
-- Finalizing a section's results writes app.result_finalizations plus one immutable row per
-- student and subject, each carrying the complete grading configuration it was computed with
-- (config_snapshot) and the computed breakdown. Later configuration edits cannot reach those rows:
-- studafy_app has no UPDATE or DELETE on them, and a finalization can only move to `superseded`
-- when an authorized correction writes a new version. Certificates likewise store their rendered
-- content and can only be superseded or revoked, never edited. Marks covered by a finalized result
-- are locked by trigger; the correction workflow unlocks them for its own transaction only.
--
-- JSONB. The three snapshot columns (config_snapshot, breakdown, certificate content) are
-- immutable documents describing what was true at finalization/issue time, not relationships; the
-- relational facts (student, subject, finalization, status, percentages) are normalized columns.
-- They are added to the approved flexible-column list in db/policies/rls-coverage.ts.
--
-- Depends on 000009 (years, terms, subjects), 000008 (students, teachers), 000147 (grade levels,
-- sections, student_sections), 000037/000120 (role-scope helpers), 000006/000025 (tenant helpers).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Lifecycle columns on existing tables
-- ---------------------------------------------------------------------------------------------------

-- draft: being set up, freely editable, no marks. active: published (validated); teachers enter
-- marks. finalized: results are final, configuration and marks are read-only except through the
-- correction workflow. archived: read-only history.
ALTER TABLE app.academic_years
  ADD COLUMN grading_config_status text NOT NULL DEFAULT 'draft',
  ADD CONSTRAINT ck_academic_years_grading_config_status
    CHECK (grading_config_status IN ('draft', 'active', 'finalized', 'archived'));

ALTER TABLE app.grade_levels ADD COLUMN archived_at timestamptz;
ALTER TABLE app.sections ADD COLUMN archived_at timestamptz;

-- Lets a section override pin itself to a section of its own grade and year.
ALTER TABLE app.sections
  ADD CONSTRAINT uq_sections_id_grade_year_school
    UNIQUE (id, grade_level_id, academic_year_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 2. Grading scales (per academic year)
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.grade_scales (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grade_scales PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_grade_scales_school_year_name UNIQUE (school_id, academic_year_id, name),
  CONSTRAINT uq_grade_scales_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_grade_scales_id_year_school UNIQUE (id, academic_year_id, school_id),
  CONSTRAINT fk_grade_scales_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_scales_academic_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_grade_scales_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_grade_scales_timestamps CHECK (updated_at >= created_at)
);

-- A band runs from its lower bound up to the next band's: overlaps and gaps are impossible by
-- construction, a shared lower bound is rejected by the unique key, and the API requires a 0 band.
CREATE TABLE app.grade_scale_bands (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grade_scale_bands PRIMARY KEY,
  school_id uuid NOT NULL,
  grade_scale_id uuid NOT NULL,
  label text NOT NULL,
  min_percentage numeric(6, 3) NOT NULL,
  gpa_points numeric(5, 2),
  CONSTRAINT uq_grade_scale_bands_scale_min UNIQUE (school_id, grade_scale_id, min_percentage),
  CONSTRAINT uq_grade_scale_bands_scale_label UNIQUE (school_id, grade_scale_id, label),
  CONSTRAINT fk_grade_scale_bands_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_scale_bands_scale FOREIGN KEY (grade_scale_id, school_id)
    REFERENCES app.grade_scales (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_grade_scale_bands_label CHECK (label = btrim(label) AND label <> ''),
  CONSTRAINT ck_grade_scale_bands_min CHECK (min_percentage >= 0 AND min_percentage <= 100),
  CONSTRAINT ck_grade_scale_bands_gpa CHECK (gpa_points IS NULL OR gpa_points >= 0)
);

-- ---------------------------------------------------------------------------------------------------
-- 3. Grade programs: one grade in one academic year, and its year-level policies
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.grade_programs (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grade_programs PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  grade_level_id uuid NOT NULL,
  -- Default scale for the grade's subjects and its overall grade label.
  grade_scale_id uuid,
  -- Failing up to this many counted subjects means supplementary exams; more means retained.
  max_failed_subjects_for_supplementary smallint NOT NULL DEFAULT 0,
  -- Whether a teacher's submitted mark sheet needs an administrator's approval.
  mark_approval_required boolean NOT NULL DEFAULT true,
  average_rounding_decimals smallint NOT NULL DEFAULT 2,
  average_rounding_mode text NOT NULL DEFAULT 'half_up',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_grade_programs_school_year_grade UNIQUE (school_id, academic_year_id, grade_level_id),
  CONSTRAINT uq_grade_programs_year_grade_school UNIQUE (academic_year_id, grade_level_id, school_id),
  CONSTRAINT fk_grade_programs_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_programs_academic_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_programs_grade_level FOREIGN KEY (grade_level_id, school_id)
    REFERENCES app.grade_levels (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_programs_scale FOREIGN KEY (grade_scale_id, academic_year_id, school_id)
    REFERENCES app.grade_scales (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_grade_programs_max_failed CHECK (max_failed_subjects_for_supplementary >= 0),
  CONSTRAINT ck_grade_programs_rounding_decimals
    CHECK (average_rounding_decimals BETWEEN 0 AND 4),
  CONSTRAINT ck_grade_programs_rounding_mode
    CHECK (average_rounding_mode IN ('half_up', 'half_even', 'floor', 'ceil')),
  CONSTRAINT ck_grade_programs_timestamps CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------------------------------
-- 4. Subject configs: grade defaults (section_id NULL) and section overrides (section_id set)
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.subject_configs (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_subject_configs PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  grade_level_id uuid NOT NULL,
  section_id uuid,
  subject_id uuid NOT NULL,
  requirement text NOT NULL DEFAULT 'mandatory',
  include_in_average boolean NOT NULL DEFAULT true,
  include_on_certificate boolean NOT NULL DEFAULT true,
  average_weight numeric(6, 2) NOT NULL DEFAULT 1,
  grading_method text NOT NULL DEFAULT 'weighted',
  max_marks numeric(8, 2) NOT NULL DEFAULT 100,
  pass_percentage numeric(6, 3) NOT NULL DEFAULT 50,
  final_exam_pass_percentage numeric(6, 3),
  grade_scale_id uuid,
  rounding_decimals smallint NOT NULL DEFAULT 2,
  rounding_mode text NOT NULL DEFAULT 'half_up',
  missing_mark_policy text NOT NULL DEFAULT 'incomplete',
  absent_policy text NOT NULL DEFAULT 'incomplete',
  retake_policy text NOT NULL DEFAULT 'none',
  retake_cap_percentage numeric(6, 3),
  teachers_can_add_assessments boolean NOT NULL DEFAULT false,
  teacher_assessments_require_approval boolean NOT NULL DEFAULT true,
  instructions text,
  is_excluded boolean NOT NULL DEFAULT false,
  -- Bumped on every change, so overrides can tell when their default moved on.
  revision integer NOT NULL DEFAULT 1,
  -- For an override: the default's revision it was forked from (NULL for a section-only subject).
  based_on_revision integer,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_subject_configs_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_subject_configs_id_year_school UNIQUE (id, academic_year_id, school_id),
  CONSTRAINT fk_subject_configs_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_configs_program FOREIGN KEY (academic_year_id, grade_level_id, school_id)
    REFERENCES app.grade_programs (academic_year_id, grade_level_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_configs_section
    FOREIGN KEY (section_id, grade_level_id, academic_year_id, school_id)
    REFERENCES app.sections (id, grade_level_id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_configs_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_configs_scale FOREIGN KEY (grade_scale_id, academic_year_id, school_id)
    REFERENCES app.grade_scales (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_subject_configs_requirement
    CHECK (requirement IN ('mandatory', 'optional', 'elective')),
  CONSTRAINT ck_subject_configs_average_weight CHECK (average_weight > 0),
  CONSTRAINT ck_subject_configs_method CHECK (grading_method IN ('weighted', 'total_points')),
  CONSTRAINT ck_subject_configs_max_marks CHECK (max_marks > 0),
  CONSTRAINT ck_subject_configs_pass CHECK (pass_percentage >= 0 AND pass_percentage <= 100),
  CONSTRAINT ck_subject_configs_final_pass CHECK (
    final_exam_pass_percentage IS NULL
    OR (final_exam_pass_percentage >= 0 AND final_exam_pass_percentage <= 100)
  ),
  CONSTRAINT ck_subject_configs_rounding_decimals CHECK (rounding_decimals BETWEEN 0 AND 4),
  CONSTRAINT ck_subject_configs_rounding_mode
    CHECK (rounding_mode IN ('half_up', 'half_even', 'floor', 'ceil')),
  CONSTRAINT ck_subject_configs_missing_policy
    CHECK (missing_mark_policy IN ('incomplete', 'zero')),
  CONSTRAINT ck_subject_configs_absent_policy CHECK (absent_policy IN ('incomplete', 'zero')),
  CONSTRAINT ck_subject_configs_retake_policy
    CHECK (retake_policy IN ('none', 'replace', 'highest', 'capped')),
  CONSTRAINT ck_subject_configs_retake_cap CHECK (
    (retake_policy = 'capped') = (retake_cap_percentage IS NOT NULL)
    AND (retake_cap_percentage IS NULL OR (retake_cap_percentage > 0 AND retake_cap_percentage <= 100))
  ),
  CONSTRAINT ck_subject_configs_instructions CHECK (
    instructions IS NULL OR (btrim(instructions) <> '' AND char_length(instructions) <= 4000)
  ),
  -- Only a section can opt out of a subject, and only a section override tracks a default revision.
  CONSTRAINT ck_subject_configs_section_only_fields CHECK (
    section_id IS NOT NULL OR (is_excluded = false AND based_on_revision IS NULL)
  ),
  CONSTRAINT ck_subject_configs_revision CHECK (revision >= 1),
  CONSTRAINT ck_subject_configs_timestamps CHECK (updated_at >= created_at)
);

-- One default per grade/year/subject, and at most one override per section/subject: no duplicate
-- subject assignments.
CREATE UNIQUE INDEX uq_subject_configs_grade_default
  ON app.subject_configs (school_id, academic_year_id, grade_level_id, subject_id)
  WHERE section_id IS NULL;
CREATE UNIQUE INDEX uq_subject_configs_section_override
  ON app.subject_configs (school_id, section_id, subject_id)
  WHERE section_id IS NOT NULL;
CREATE INDEX idx_subject_configs_subject_fk ON app.subject_configs (subject_id, school_id);
CREATE INDEX idx_subject_configs_scale_fk ON app.subject_configs (grade_scale_id, academic_year_id, school_id)
  WHERE grade_scale_id IS NOT NULL;
CREATE INDEX idx_subject_configs_section_fk
  ON app.subject_configs (section_id, grade_level_id, academic_year_id, school_id)
  WHERE section_id IS NOT NULL;

-- A term's share of the annual grade for one subject config.
CREATE TABLE app.subject_config_term_weights (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_subject_config_term_weights PRIMARY KEY,
  school_id uuid NOT NULL,
  subject_config_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  term_id uuid NOT NULL,
  weight numeric(6, 3) NOT NULL,
  CONSTRAINT uq_subject_config_term_weights_config_term
    UNIQUE (school_id, subject_config_id, term_id),
  CONSTRAINT fk_subject_config_term_weights_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_config_term_weights_config
    FOREIGN KEY (subject_config_id, academic_year_id, school_id)
    REFERENCES app.subject_configs (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_subject_config_term_weights_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_subject_config_term_weights_weight CHECK (weight >= 0 AND weight <= 100)
);
CREATE INDEX idx_subject_config_term_weights_term_fk
  ON app.subject_config_term_weights (term_id, academic_year_id, school_id);
CREATE INDEX idx_subject_config_term_weights_config_fk
  ON app.subject_config_term_weights (subject_config_id, academic_year_id, school_id);

CREATE TABLE app.subject_config_categories (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_subject_config_categories PRIMARY KEY,
  school_id uuid NOT NULL,
  subject_config_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'other',
  scope text NOT NULL DEFAULT 'annual',
  -- Share of the period grade (weighted method); NULL for total-points subjects.
  weight numeric(6, 3),
  aggregation text NOT NULL DEFAULT 'weighted_average',
  drop_lowest smallint NOT NULL DEFAULT 0,
  sort_order smallint NOT NULL DEFAULT 0,
  CONSTRAINT uq_subject_config_categories_config_name UNIQUE (school_id, subject_config_id, name),
  CONSTRAINT uq_subject_config_categories_id_config_school
    UNIQUE (id, subject_config_id, school_id),
  CONSTRAINT fk_subject_config_categories_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_config_categories_config FOREIGN KEY (subject_config_id, school_id)
    REFERENCES app.subject_configs (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_subject_config_categories_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_subject_config_categories_kind CHECK (kind IN (
    'homework', 'quiz', 'classwork', 'project', 'practical', 'participation', 'exam', 'midterm',
    'final_exam', 'other'
  )),
  CONSTRAINT ck_subject_config_categories_scope CHECK (scope IN ('term', 'annual')),
  CONSTRAINT ck_subject_config_categories_weight CHECK (weight IS NULL OR (weight >= 0 AND weight <= 100)),
  CONSTRAINT ck_subject_config_categories_aggregation
    CHECK (aggregation IN ('weighted_average', 'total_points')),
  CONSTRAINT ck_subject_config_categories_drop_lowest CHECK (drop_lowest >= 0)
);
CREATE INDEX idx_subject_config_categories_config_fk
  ON app.subject_config_categories (subject_config_id, school_id);

CREATE TABLE app.subject_config_assessments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_subject_config_assessments PRIMARY KEY,
  school_id uuid NOT NULL,
  subject_config_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  category_id uuid NOT NULL,
  -- The term a term-scope assessment belongs to; NULL for annual-scope assessments.
  term_id uuid,
  -- Set only for an assessment added to one section on an inherited (grade default) config.
  section_id uuid,
  name text NOT NULL,
  max_marks numeric(8, 2) NOT NULL,
  weight numeric(8, 3) NOT NULL DEFAULT 1,
  is_mandatory boolean NOT NULL DEFAULT true,
  assessment_date date,
  due_date date,
  -- `proposed`: a teacher's addition awaiting approval; not counted until `active`.
  status text NOT NULL DEFAULT 'active',
  created_by_user_id uuid,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_subject_config_assessments_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_subject_config_assessments_id_year_school UNIQUE (id, academic_year_id, school_id),
  CONSTRAINT fk_subject_config_assessments_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_config_assessments_config
    FOREIGN KEY (subject_config_id, academic_year_id, school_id)
    REFERENCES app.subject_configs (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  -- The category must belong to the same config: an assessment is counted in exactly one place.
  CONSTRAINT fk_subject_config_assessments_category
    FOREIGN KEY (category_id, subject_config_id, school_id)
    REFERENCES app.subject_config_categories (id, subject_config_id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_subject_config_assessments_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_config_assessments_section
    FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subject_config_assessments_created_by FOREIGN KEY (created_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_subject_config_assessments_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_subject_config_assessments_max_marks CHECK (max_marks > 0),
  CONSTRAINT ck_subject_config_assessments_weight CHECK (weight > 0),
  CONSTRAINT ck_subject_config_assessments_status
    CHECK (status IN ('active', 'proposed', 'rejected')),
  CONSTRAINT ck_subject_config_assessments_dates
    CHECK (due_date IS NULL OR assessment_date IS NULL OR due_date >= assessment_date),
  CONSTRAINT ck_subject_config_assessments_timestamps CHECK (updated_at >= created_at)
);
CREATE INDEX idx_subject_config_assessments_school_config
  ON app.subject_config_assessments (school_id, subject_config_id, sort_order);
CREATE INDEX idx_subject_config_assessments_category_fk
  ON app.subject_config_assessments (category_id, subject_config_id, school_id);
CREATE INDEX idx_subject_config_assessments_config_fk
  ON app.subject_config_assessments (subject_config_id, academic_year_id, school_id);
CREATE INDEX idx_subject_config_assessments_term_fk
  ON app.subject_config_assessments (term_id, academic_year_id, school_id) WHERE term_id IS NOT NULL;
CREATE INDEX idx_subject_config_assessments_section_fk
  ON app.subject_config_assessments (section_id, academic_year_id, school_id)
  WHERE section_id IS NOT NULL;
CREATE INDEX idx_subject_config_assessments_created_by_fk
  ON app.subject_config_assessments (created_by_user_id, school_id)
  WHERE created_by_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- 5. Who takes what, and who teaches it
-- ---------------------------------------------------------------------------------------------------

-- Optional and elective subjects are taken only by students with an `enrolled` row; any subject
-- can carry an `exempt` row (excluded from results, with a reason).
CREATE TABLE app.student_subject_enrollments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_subject_enrollments PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  student_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  status text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_student_subject_enrollments_year_student_subject
    UNIQUE (school_id, academic_year_id, student_id, subject_id),
  CONSTRAINT fk_student_subject_enrollments_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_subject_enrollments_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_subject_enrollments_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_subject_enrollments_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_subject_enrollments_status CHECK (status IN ('enrolled', 'exempt')),
  CONSTRAINT ck_student_subject_enrollments_reason CHECK (
    (status = 'exempt') = (reason IS NOT NULL)
    AND (reason IS NULL OR (btrim(reason) <> '' AND char_length(reason) <= 1000))
  ),
  CONSTRAINT ck_student_subject_enrollments_timestamps CHECK (updated_at >= created_at)
);
CREATE INDEX idx_student_subject_enrollments_student_fk
  ON app.student_subject_enrollments (student_id, school_id);
CREATE INDEX idx_student_subject_enrollments_subject_fk
  ON app.student_subject_enrollments (subject_id, school_id);

CREATE TABLE app.section_subject_teachers (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_section_subject_teachers PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  section_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_section_subject_teachers_assignment
    UNIQUE (school_id, section_id, subject_id, teacher_id),
  CONSTRAINT fk_section_subject_teachers_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_section_subject_teachers_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_section_subject_teachers_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_section_subject_teachers_teacher FOREIGN KEY (teacher_id, school_id)
    REFERENCES app.teachers (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX idx_section_subject_teachers_school_teacher
  ON app.section_subject_teachers (school_id, teacher_id, academic_year_id);
CREATE INDEX idx_section_subject_teachers_section_fk
  ON app.section_subject_teachers (section_id, academic_year_id, school_id);
CREATE INDEX idx_section_subject_teachers_subject_fk
  ON app.section_subject_teachers (subject_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 6. Marks and mark sheets
-- ---------------------------------------------------------------------------------------------------

-- No row means "not yet graded" (pending). attempt 2 is a retake / supplementary sitting.
CREATE TABLE app.student_marks (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_marks PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  attempt smallint NOT NULL DEFAULT 1,
  status text NOT NULL,
  score numeric(10, 2),
  remarks text,
  entered_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_student_marks_assessment_student_attempt
    UNIQUE (school_id, assessment_id, student_id, attempt),
  CONSTRAINT fk_student_marks_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- RESTRICT: an assessment with marks cannot be deleted out from under them.
  CONSTRAINT fk_student_marks_assessment FOREIGN KEY (assessment_id, academic_year_id, school_id)
    REFERENCES app.subject_config_assessments (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_marks_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_marks_entered_by FOREIGN KEY (entered_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_marks_attempt CHECK (attempt IN (1, 2)),
  CONSTRAINT ck_student_marks_status
    CHECK (status IN ('graded', 'absent', 'excused', 'not_applicable')),
  CONSTRAINT ck_student_marks_score CHECK (
    (status = 'graded') = (score IS NOT NULL) AND (score IS NULL OR score >= 0)
  ),
  CONSTRAINT ck_student_marks_remarks
    CHECK (remarks IS NULL OR (btrim(remarks) <> '' AND char_length(remarks) <= 1000)),
  CONSTRAINT ck_student_marks_timestamps CHECK (updated_at >= created_at)
);
CREATE INDEX idx_student_marks_school_student ON app.student_marks (school_id, student_id, academic_year_id);
CREATE INDEX idx_student_marks_assessment_fk
  ON app.student_marks (assessment_id, academic_year_id, school_id);
CREATE INDEX idx_student_marks_entered_by_fk ON app.student_marks (entered_by_user_id, school_id);

-- A teacher's submission of one section's marks for one subject and period (term, or NULL for
-- the annual-only assessments). Approved sheets lock their marks.
CREATE TABLE app.mark_sheets (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_mark_sheets PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  section_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  term_id uuid,
  status text NOT NULL DEFAULT 'draft',
  submitted_by_user_id uuid,
  submitted_at timestamptz,
  decided_by_user_id uuid,
  decided_at timestamptz,
  return_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_mark_sheets_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_mark_sheets_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_mark_sheets_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_mark_sheets_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_mark_sheets_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_mark_sheets_submitted_by FOREIGN KEY (submitted_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_mark_sheets_decided_by FOREIGN KEY (decided_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_mark_sheets_status CHECK (status IN ('draft', 'submitted', 'approved', 'returned')),
  CONSTRAINT ck_mark_sheets_lifecycle CHECK (
    (status = 'draft' AND decided_at IS NULL AND return_reason IS NULL)
    OR (status = 'submitted' AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
        AND return_reason IS NULL)
    OR (status = 'approved' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
        AND return_reason IS NULL)
    OR (status = 'returned' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
        AND return_reason IS NOT NULL AND btrim(return_reason) <> '')
  ),
  CONSTRAINT ck_mark_sheets_timestamps CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX uq_mark_sheets_term
  ON app.mark_sheets (school_id, section_id, subject_id, term_id) WHERE term_id IS NOT NULL;
CREATE UNIQUE INDEX uq_mark_sheets_annual
  ON app.mark_sheets (school_id, section_id, subject_id) WHERE term_id IS NULL;
CREATE INDEX idx_mark_sheets_school_status ON app.mark_sheets (school_id, status, submitted_at);
CREATE INDEX idx_mark_sheets_section_fk ON app.mark_sheets (section_id, academic_year_id, school_id);
CREATE INDEX idx_mark_sheets_subject_fk ON app.mark_sheets (subject_id, school_id);
CREATE INDEX idx_mark_sheets_term_fk ON app.mark_sheets (term_id, academic_year_id, school_id)
  WHERE term_id IS NOT NULL;
CREATE INDEX idx_mark_sheets_submitted_by_fk ON app.mark_sheets (submitted_by_user_id, school_id)
  WHERE submitted_by_user_id IS NOT NULL;
CREATE INDEX idx_mark_sheets_decided_by_fk ON app.mark_sheets (decided_by_user_id, school_id)
  WHERE decided_by_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- 7. Finalized results (immutable snapshots)
-- ---------------------------------------------------------------------------------------------------

-- One finalization of one section's results for a term (term_id) or the year (term_id NULL).
-- A correction writes version n+1 with supersedes_id and moves the old one to `superseded`.
CREATE TABLE app.result_finalizations (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_result_finalizations PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  section_id uuid NOT NULL,
  term_id uuid,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'finalized',
  finalized_by_user_id uuid NOT NULL,
  finalized_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  supersedes_id uuid,
  correction_reason text,
  superseded_at timestamptz,
  CONSTRAINT uq_result_finalizations_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_result_finalizations_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_result_finalizations_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_result_finalizations_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_result_finalizations_finalized_by FOREIGN KEY (finalized_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_result_finalizations_supersedes FOREIGN KEY (supersedes_id, school_id)
    REFERENCES app.result_finalizations (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_result_finalizations_status CHECK (status IN ('finalized', 'superseded')),
  CONSTRAINT ck_result_finalizations_version CHECK (version >= 1),
  -- A correction (version > 1) always supersedes something and says why.
  CONSTRAINT ck_result_finalizations_correction CHECK (
    (version = 1 AND supersedes_id IS NULL AND correction_reason IS NULL)
    OR (version > 1 AND supersedes_id IS NOT NULL AND correction_reason IS NOT NULL
        AND btrim(correction_reason) <> '' AND char_length(correction_reason) <= 2000)
  ),
  CONSTRAINT ck_result_finalizations_superseded
    CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_result_finalizations_current_term
  ON app.result_finalizations (school_id, section_id, term_id)
  WHERE status = 'finalized' AND term_id IS NOT NULL;
CREATE UNIQUE INDEX uq_result_finalizations_current_annual
  ON app.result_finalizations (school_id, section_id)
  WHERE status = 'finalized' AND term_id IS NULL;
CREATE INDEX idx_result_finalizations_school_year
  ON app.result_finalizations (school_id, academic_year_id, section_id, finalized_at DESC);
CREATE INDEX idx_result_finalizations_section_fk
  ON app.result_finalizations (section_id, academic_year_id, school_id);
CREATE INDEX idx_result_finalizations_term_fk
  ON app.result_finalizations (term_id, academic_year_id, school_id) WHERE term_id IS NOT NULL;
CREATE INDEX idx_result_finalizations_finalized_by_fk
  ON app.result_finalizations (finalized_by_user_id, school_id);
CREATE INDEX idx_result_finalizations_supersedes_fk
  ON app.result_finalizations (supersedes_id, school_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE app.student_subject_results (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_subject_results PRIMARY KEY,
  school_id uuid NOT NULL,
  finalization_id uuid NOT NULL,
  student_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  -- The config row the result was computed from, for navigation only: the rules themselves are
  -- config_snapshot, which a later edit to that row cannot change.
  subject_config_id uuid,
  status text NOT NULL,
  percentage numeric(7, 3),
  marks_obtained numeric(10, 3),
  max_marks numeric(8, 2) NOT NULL,
  grade_label text,
  gpa_points numeric(5, 2),
  passed boolean,
  include_in_average boolean NOT NULL,
  include_on_certificate boolean NOT NULL,
  config_snapshot jsonb NOT NULL,
  breakdown jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_student_subject_results_finalization_student_subject
    UNIQUE (school_id, finalization_id, student_id, subject_id),
  CONSTRAINT fk_student_subject_results_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_subject_results_finalization FOREIGN KEY (finalization_id, school_id)
    REFERENCES app.result_finalizations (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_subject_results_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_subject_results_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- SET NULL is not available on a composite key that includes school_id; RESTRICT keeps a config
  -- that results point at from being deleted, which is also what history wants.
  CONSTRAINT fk_student_subject_results_config FOREIGN KEY (subject_config_id, school_id)
    REFERENCES app.subject_configs (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_subject_results_status CHECK (status IN ('complete', 'incomplete', 'exempt')),
  -- Only a complete result carries a percentage, marks and a pass/fail decision.
  CONSTRAINT ck_student_subject_results_complete CHECK (
    (status = 'complete') = (percentage IS NOT NULL AND marks_obtained IS NOT NULL AND passed IS NOT NULL)
  ),
  CONSTRAINT ck_student_subject_results_percentage
    CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),
  CONSTRAINT ck_student_subject_results_max_marks CHECK (max_marks > 0),
  CONSTRAINT ck_student_subject_results_snapshot CHECK (jsonb_typeof(config_snapshot) = 'object'),
  CONSTRAINT ck_student_subject_results_breakdown CHECK (jsonb_typeof(breakdown) = 'object')
);
CREATE INDEX idx_student_subject_results_school_student
  ON app.student_subject_results (school_id, student_id, finalization_id);
CREATE INDEX idx_student_subject_results_student_fk
  ON app.student_subject_results (student_id, school_id);
CREATE INDEX idx_student_subject_results_subject_fk
  ON app.student_subject_results (subject_id, school_id);
CREATE INDEX idx_student_subject_results_config_fk
  ON app.student_subject_results (subject_config_id, school_id) WHERE subject_config_id IS NOT NULL;

CREATE TABLE app.student_overall_results (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_overall_results PRIMARY KEY,
  school_id uuid NOT NULL,
  finalization_id uuid NOT NULL,
  student_id uuid NOT NULL,
  status text NOT NULL,
  average_percentage numeric(7, 3),
  total_obtained numeric(12, 3),
  total_max numeric(12, 2),
  grade_label text,
  subjects_failed smallint NOT NULL DEFAULT 0,
  academic_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_student_overall_results_finalization_student
    UNIQUE (school_id, finalization_id, student_id),
  CONSTRAINT uq_student_overall_results_key UNIQUE (finalization_id, student_id, school_id),
  CONSTRAINT fk_student_overall_results_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_overall_results_finalization FOREIGN KEY (finalization_id, school_id)
    REFERENCES app.result_finalizations (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_overall_results_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_overall_results_status CHECK (status IN ('complete', 'incomplete')),
  CONSTRAINT ck_student_overall_results_academic_status
    CHECK (academic_status IN ('promoted', 'supplementary', 'retained', 'incomplete')),
  CONSTRAINT ck_student_overall_results_incomplete CHECK (
    (status = 'incomplete') = (academic_status = 'incomplete')
    AND (status = 'complete' OR average_percentage IS NULL)
  ),
  CONSTRAINT ck_student_overall_results_average CHECK (
    average_percentage IS NULL OR (average_percentage >= 0 AND average_percentage <= 100)
  ),
  CONSTRAINT ck_student_overall_results_failed CHECK (subjects_failed >= 0)
);
CREATE INDEX idx_student_overall_results_student_fk
  ON app.student_overall_results (student_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 8. Certificates and report cards
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.certificates (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_certificates PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  student_id uuid NOT NULL,
  finalization_id uuid NOT NULL,
  -- annual_certificate: from an annual finalization; term_report: a term report card.
  kind text NOT NULL,
  serial_number text NOT NULL,
  status text NOT NULL DEFAULT 'issued',
  issued_by_user_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  supersedes_id uuid,
  reissue_reason text,
  superseded_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  revoke_reason text,
  -- The rendered certificate exactly as issued. Never rebuilt from live data.
  content jsonb NOT NULL,
  content_sha256 text NOT NULL,
  CONSTRAINT uq_certificates_school_serial UNIQUE (school_id, serial_number),
  CONSTRAINT uq_certificates_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_certificates_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_certificates_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_certificates_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Only a student with an overall result in the finalization can hold its certificate.
  CONSTRAINT fk_certificates_overall_result FOREIGN KEY (finalization_id, student_id, school_id)
    REFERENCES app.student_overall_results (finalization_id, student_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_certificates_issued_by FOREIGN KEY (issued_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_certificates_revoked_by FOREIGN KEY (revoked_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_certificates_supersedes FOREIGN KEY (supersedes_id, school_id)
    REFERENCES app.certificates (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_certificates_kind CHECK (kind IN ('annual_certificate', 'term_report')),
  CONSTRAINT ck_certificates_serial CHECK (serial_number = btrim(serial_number) AND serial_number <> ''),
  CONSTRAINT ck_certificates_status CHECK (status IN ('issued', 'superseded', 'revoked')),
  CONSTRAINT ck_certificates_reissue CHECK (
    (supersedes_id IS NULL) = (reissue_reason IS NULL)
    AND (reissue_reason IS NULL OR (btrim(reissue_reason) <> '' AND char_length(reissue_reason) <= 2000))
  ),
  CONSTRAINT ck_certificates_superseded CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CONSTRAINT ck_certificates_revoked CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
      AND revoke_reason IS NOT NULL AND btrim(revoke_reason) <> '')
  ),
  CONSTRAINT ck_certificates_content CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT ck_certificates_sha CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);
-- One current certificate per student, finalization period and kind.
CREATE UNIQUE INDEX uq_certificates_current
  ON app.certificates (school_id, student_id, finalization_id, kind) WHERE status = 'issued';
CREATE INDEX idx_certificates_school_year_student
  ON app.certificates (school_id, academic_year_id, student_id, issued_at DESC);
CREATE INDEX idx_certificates_year_fk ON app.certificates (academic_year_id, school_id);
CREATE INDEX idx_certificates_student_fk ON app.certificates (student_id, school_id);
CREATE INDEX idx_certificates_overall_result_fk
  ON app.certificates (finalization_id, student_id, school_id);
CREATE INDEX idx_certificates_issued_by_fk ON app.certificates (issued_by_user_id, school_id);
CREATE INDEX idx_certificates_revoked_by_fk ON app.certificates (revoked_by_user_id, school_id)
  WHERE revoked_by_user_id IS NOT NULL;
CREATE INDEX idx_certificates_supersedes_fk ON app.certificates (supersedes_id, school_id)
  WHERE supersedes_id IS NOT NULL;

COMMENT ON TABLE app.grade_programs IS
  'A grade in one academic year (000160): its default scale and promotion/approval policies.';
COMMENT ON TABLE app.subject_configs IS
  'A subject''s grading rules for a grade (section_id NULL, inherited by every section) or a section override (000160).';
COMMENT ON TABLE app.student_marks IS
  'Marks per assessment and student (000160). No row = not yet graded; attempt 2 = retake.';
COMMENT ON TABLE app.result_finalizations IS
  'Immutable finalization of a section''s term or annual results (000160); corrections supersede.';
COMMENT ON TABLE app.certificates IS
  'Issued report cards and certificates with their rendered content (000160); never edited, only superseded or revoked.';

-- ---------------------------------------------------------------------------------------------------
-- 9. Immutability triggers
-- ---------------------------------------------------------------------------------------------------

-- A finalization can only move finalized -> superseded (stamping superseded_at). Nothing else on it
-- changes after insert.
CREATE FUNCTION app.enforce_result_finalization_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finalized results cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NOT (OLD.status = 'finalized' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'a result finalization can only be superseded' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW.school_id, NEW.academic_year_id, NEW.section_id, NEW.term_id, NEW.version,
      NEW.finalized_by_user_id, NEW.finalized_at, NEW.supersedes_id, NEW.correction_reason)
     IS DISTINCT FROM
     (OLD.id, OLD.school_id, OLD.academic_year_id, OLD.section_id, OLD.term_id, OLD.version,
      OLD.finalized_by_user_id, OLD.finalized_at, OLD.supersedes_id, OLD.correction_reason) THEN
    RAISE EXCEPTION 'a result finalization is immutable apart from being superseded'
      USING ERRCODE = '23514';
  END IF;
  NEW.superseded_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_result_finalizations_immutable
BEFORE UPDATE OR DELETE ON app.result_finalizations
FOR EACH ROW EXECUTE FUNCTION app.enforce_result_finalization_immutability();

ALTER FUNCTION app.enforce_result_finalization_immutability() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.enforce_result_finalization_immutability() FROM PUBLIC, studafy_app;

-- A certificate's content never changes. It can be superseded by a reissue or revoked, once.
CREATE FUNCTION app.enforce_certificate_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'issued certificates cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'issued' OR NEW.status NOT IN ('superseded', 'revoked') THEN
    RAISE EXCEPTION 'certificate status cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW.school_id, NEW.academic_year_id, NEW.student_id, NEW.finalization_id, NEW.kind,
      NEW.serial_number, NEW.issued_by_user_id, NEW.issued_at, NEW.supersedes_id,
      NEW.reissue_reason, NEW.content, NEW.content_sha256)
     IS DISTINCT FROM
     (OLD.id, OLD.school_id, OLD.academic_year_id, OLD.student_id, OLD.finalization_id, OLD.kind,
      OLD.serial_number, OLD.issued_by_user_id, OLD.issued_at, OLD.supersedes_id,
      OLD.reissue_reason, OLD.content, OLD.content_sha256) THEN
    RAISE EXCEPTION 'an issued certificate is immutable apart from its status'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'superseded' THEN
    NEW.superseded_at := CURRENT_TIMESTAMP;
  ELSE
    NEW.revoked_at := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_certificates_immutable
BEFORE UPDATE OR DELETE ON app.certificates
FOR EACH ROW EXECUTE FUNCTION app.enforce_certificate_immutability();

ALTER FUNCTION app.enforce_certificate_immutability() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.enforce_certificate_immutability() FROM PUBLIC, studafy_app;

-- Marks covered by a current finalization of the student's section are locked: a term
-- finalization locks that term's assessments, an annual one locks all of them. The correction
-- workflow sets app.result_correction = 'on' for its own transaction; nothing else may.
CREATE FUNCTION app.reject_finalized_mark_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  target app.student_marks%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD; ELSE target := NEW; END IF;
  IF COALESCE(current_setting('app.result_correction', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app.subject_config_assessments AS assessment
    JOIN app.student_sections AS placement
      ON placement.student_id = target.student_id
     AND placement.academic_year_id = assessment.academic_year_id
     AND placement.school_id = assessment.school_id
    JOIN app.result_finalizations AS finalization
      ON finalization.section_id = placement.section_id
     AND finalization.school_id = placement.school_id
     AND finalization.status = 'finalized'
     AND (finalization.term_id IS NULL OR finalization.term_id = assessment.term_id)
    WHERE assessment.id = target.assessment_id
      AND assessment.school_id = target.school_id
  ) THEN
    RAISE EXCEPTION 'this mark is part of finalized results; use the correction workflow'
      USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

CREATE TRIGGER trg_student_marks_finalized_lock
BEFORE INSERT OR UPDATE OR DELETE ON app.student_marks
FOR EACH ROW EXECUTE FUNCTION app.reject_finalized_mark_change();

ALTER FUNCTION app.reject_finalized_mark_change() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.reject_finalized_mark_change() FROM PUBLIC, studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 10. Visibility helpers
-- ---------------------------------------------------------------------------------------------------

-- True when the current user teaches `target_subject_id` to `target_section_id`: an explicit
-- assignment, or a class of that section whose course is in that subject (the same lead-teacher /
-- timetable-slot rule as app.teaches_class), so schools already running classes need no re-entry.
CREATE FUNCTION app.teaches_section_subject(target_section_id uuid, target_subject_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_teacher_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM app.section_subject_teachers AS assignment
        WHERE assignment.school_id = current_setting('app.school_id')::uuid
          AND assignment.section_id = target_section_id
          AND assignment.subject_id = target_subject_id
          AND assignment.teacher_id = app.current_user_teacher_id()
      )
      OR EXISTS (
        SELECT 1
        FROM app.classes AS class
        JOIN app.courses AS course ON course.id = class.course_id AND course.school_id = class.school_id
        WHERE class.school_id = current_setting('app.school_id')::uuid
          AND class.section_id = target_section_id
          AND course.subject_id = target_subject_id
          AND app.teaches_class(class.id)
      )
    )
$function$;

-- Raw marks are staff data: school leadership, or a teacher of that student's section in the
-- assessment's subject. Students and parents see finalized results, never in-progress marks.
CREATE FUNCTION app.can_read_student_mark(target_student_id uuid, target_assessment_id uuid)
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
$function$;

-- Finalized results: leadership, the student and their parents, or a teacher of the student's
-- section (in any subject) for that year.
CREATE FUNCTION app.can_read_student_result(target_student_id uuid, target_finalization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR app.is_related_to_student(target_student_id)
    OR (
      app.current_user_teacher_id() IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM app.result_finalizations AS finalization
        JOIN app.section_subject_teachers AS assignment
          ON assignment.section_id = finalization.section_id
         AND assignment.school_id = finalization.school_id
        WHERE finalization.id = target_finalization_id
          AND finalization.school_id = current_setting('app.school_id')::uuid
          AND assignment.teacher_id = app.current_user_teacher_id()
      )
    )
$function$;

-- A teacher assigned to a subject in a section (app.section_subject_teachers) must see that subject
-- and the section's students, exactly as a class's teacher already does through app.classes. Both
-- helpers keep their 000037 bodies and gain one more arm; CREATE OR REPLACE keeps owner and grants.
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
$function$;

CREATE OR REPLACE FUNCTION app.can_read_student(target_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.is_privileged_over_student(target_student_id)
      OR app.is_related_to_student(target_student_id)
      OR (
        app.current_user_teacher_id() IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM app.student_sections AS placement
          JOIN app.section_subject_teachers AS assignment
            ON assignment.section_id = placement.section_id
           AND assignment.school_id = placement.school_id
          WHERE placement.student_id = target_student_id
            AND placement.school_id = current_setting('app.school_id')::uuid
            AND assignment.teacher_id = app.current_user_teacher_id()
        )
      )
$function$;

ALTER FUNCTION app.teaches_section_subject(uuid, uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.can_read_student_mark(uuid, uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.can_read_student_result(uuid, uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.teaches_section_subject(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.can_read_student_mark(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.can_read_student_result(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teaches_section_subject(uuid, uuid) TO studafy_app;
GRANT EXECUTE ON FUNCTION app.can_read_student_mark(uuid, uuid) TO studafy_app;
GRANT EXECUTE ON FUNCTION app.can_read_student_result(uuid, uuid) TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 11. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

-- 000002's default privileges grant studafy_app full DML on new tables, so revoke from it as well
-- as PUBLIC before granting exactly what each table needs.
REVOKE ALL PRIVILEGES ON TABLE
  app.grade_scales, app.grade_scale_bands, app.grade_programs, app.subject_configs,
  app.subject_config_term_weights, app.subject_config_categories, app.subject_config_assessments,
  app.student_subject_enrollments, app.section_subject_teachers, app.student_marks,
  app.mark_sheets, app.result_finalizations, app.student_subject_results,
  app.student_overall_results, app.certificates
FROM PUBLIC, studafy_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.grade_scales, app.grade_scale_bands, app.grade_programs, app.subject_configs,
  app.subject_config_term_weights, app.subject_config_categories, app.subject_config_assessments,
  app.student_subject_enrollments, app.section_subject_teachers, app.student_marks,
  app.mark_sheets
TO studafy_app;
-- Results are append-only; a finalization and a certificate change only by trigger-checked status.
GRANT SELECT, INSERT ON TABLE app.student_subject_results, app.student_overall_results TO studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.result_finalizations, app.certificates TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'grade_scales');
SELECT app.apply_tenant_isolation('app', 'grade_scale_bands');
SELECT app.apply_tenant_isolation('app', 'grade_programs');
SELECT app.apply_tenant_isolation('app', 'subject_configs');
SELECT app.apply_tenant_isolation('app', 'subject_config_term_weights');
SELECT app.apply_tenant_isolation('app', 'subject_config_categories');
SELECT app.apply_tenant_isolation('app', 'subject_config_assessments');
SELECT app.apply_tenant_isolation('app', 'student_subject_enrollments');
SELECT app.apply_tenant_isolation('app', 'section_subject_teachers');
SELECT app.apply_tenant_isolation('app', 'student_marks');
SELECT app.apply_tenant_isolation('app', 'mark_sheets');
SELECT app.apply_tenant_isolation('app', 'result_finalizations');
SELECT app.apply_tenant_isolation('app', 'student_subject_results');
SELECT app.apply_tenant_isolation('app', 'student_overall_results');
SELECT app.apply_tenant_isolation('app', 'certificates');

-- Configuration (scales, programs, subject configs, assessments, teacher assignments) is not
-- personal data: tenant isolation only, so a teacher's app can show the rules it grades by.
-- Student-level rows are scoped.
CREATE POLICY role_scope_visibility ON app.student_marks
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student_mark(student_id, assessment_id));

CREATE POLICY role_scope_visibility ON app.student_subject_enrollments
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student_for_attendance(student_id) OR app.is_related_to_student(student_id));

CREATE POLICY role_scope_visibility ON app.student_subject_results
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student_result(student_id, finalization_id));

CREATE POLICY role_scope_visibility ON app.student_overall_results
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student_result(student_id, finalization_id));

CREATE POLICY role_scope_visibility ON app.certificates
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student_result(student_id, finalization_id));

RESET ROLE;
