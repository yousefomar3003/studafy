-- Lesson and term plans + learning outcomes (docs/plans/academic-phase2.md, WS-O).
--
--   app.academic_planning_settings      per school: outcome achievement on report cards (off by
--                                       default) and when plans are due (for the coverage view).
--                                       No row: the defaults.
--   app.outcome_achievement_levels      the school's achievement scale (1 = lowest). No rows: the
--                                       default four (Beginning, Developing, Meeting, Exceeding).
--   app.learning_outcomes               the catalogue, per subject and grade level: code, text in
--                                       English and optionally Arabic, optional strand. Archived
--                                       rather than deleted once used.
--   app.student_outcome_achievements    a teacher's level per student, outcome and period (a term,
--                                       or the year when term_id is NULL), in the student's section.
--   app.finalized_outcome_achievements  append-only snapshot copied at finalization when the school
--                                       shows outcomes on report cards (ADR-017): code, text and
--                                       labels as they were, so a later catalogue edit never
--                                       rewrites a report card.
--   app.term_plans (+ _weeks, _week_outcomes)
--                                       a section + subject's plan for a term: weeks with unit,
--                                       notes and outcomes, and overall notes.
--   app.lesson_plans (+ _outcomes, _materials)
--                                       a daily lesson: date and timetable period, objectives,
--                                       outcomes, activities, resources (uploaded class materials,
--                                       title copied), homework, reflection.
--
-- Plans move draft -> submitted -> approved | returned (with a comment); a returned plan is edited
-- and submitted again. Teachers of the section and subject write them; the subject's coordinator
-- (000261) or school leadership reviews them. Review history is in app.audit_logs.
--
-- PRIVACY. Plans and draft achievements are staff data: school leadership, a teacher of the section
-- and subject, or its coordinator (app.can_read_section_subject_work). Students and parents read
-- achievement only from the finalized snapshot, through the finalized-results rule
-- (app.can_read_student_result), and only when the school switched it on before finalizing.
-- Settings, the scale and the catalogue are configuration (tenant isolation only).
--
-- Additive only (docs/database/migration-policy.md): new tables and one new helper. No existing
-- function or policy changes.
--
-- Depends on 000009 (years, terms, subjects), 000011 (materials), 000147 (grade levels, sections),
-- 000160 (results, app.teaches_section_subject, app.can_read_student_result) and 000261
-- (app.coordinates_section_subject, app.coordinates_result_subject).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Settings and the achievement scale
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.academic_planning_settings (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_academic_planning_settings PRIMARY KEY,
  school_id uuid NOT NULL,
  show_outcomes_on_report_cards boolean NOT NULL DEFAULT false,
  -- A lesson plan is on time when submitted at least this many days before the lesson.
  lesson_plan_lead_days smallint NOT NULL DEFAULT 1,
  -- A term plan is on time when submitted by the term's first day plus this many days.
  term_plan_due_days smallint NOT NULL DEFAULT 7,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_academic_planning_settings_school UNIQUE (school_id),
  CONSTRAINT fk_academic_planning_settings_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_academic_planning_settings_lead_days CHECK (lesson_plan_lead_days BETWEEN 0 AND 30),
  CONSTRAINT ck_academic_planning_settings_due_days CHECK (term_plan_due_days BETWEEN -90 AND 90),
  CONSTRAINT ck_academic_planning_settings_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.outcome_achievement_levels (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_outcome_achievement_levels PRIMARY KEY,
  school_id uuid NOT NULL,
  level smallint NOT NULL,
  label text NOT NULL,
  label_ar text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_outcome_achievement_levels_school_level UNIQUE (school_id, level),
  CONSTRAINT fk_outcome_achievement_levels_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_outcome_achievement_levels_level CHECK (level BETWEEN 1 AND 10),
  CONSTRAINT ck_outcome_achievement_levels_label
    CHECK (label = btrim(label) AND label <> '' AND char_length(label) <= 60),
  CONSTRAINT ck_outcome_achievement_levels_label_ar CHECK (
    label_ar IS NULL OR (label_ar = btrim(label_ar) AND label_ar <> '' AND char_length(label_ar) <= 60)
  )
);

-- ---------------------------------------------------------------------------------------------------
-- 2. The learning outcomes catalogue
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.learning_outcomes (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_learning_outcomes PRIMARY KEY,
  school_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  grade_level_id uuid NOT NULL,
  code text NOT NULL,
  text text NOT NULL,
  text_ar text,
  strand text,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_learning_outcomes_id_school UNIQUE (id, school_id),
  -- Lets an achievement prove its subject is the outcome's.
  CONSTRAINT uq_learning_outcomes_id_subject_school UNIQUE (id, subject_id, school_id),
  CONSTRAINT uq_learning_outcomes_code UNIQUE (school_id, subject_id, grade_level_id, code),
  CONSTRAINT fk_learning_outcomes_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_learning_outcomes_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_learning_outcomes_grade_level FOREIGN KEY (grade_level_id, school_id)
    REFERENCES app.grade_levels (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_learning_outcomes_code
    CHECK (code = btrim(code) AND code <> '' AND char_length(code) <= 40),
  CONSTRAINT ck_learning_outcomes_text
    CHECK (text = btrim(text) AND text <> '' AND char_length(text) <= 1000),
  CONSTRAINT ck_learning_outcomes_text_ar CHECK (
    text_ar IS NULL OR (text_ar = btrim(text_ar) AND text_ar <> '' AND char_length(text_ar) <= 1000)
  ),
  CONSTRAINT ck_learning_outcomes_strand CHECK (
    strand IS NULL OR (strand = btrim(strand) AND strand <> '' AND char_length(strand) <= 120)
  ),
  CONSTRAINT ck_learning_outcomes_sort CHECK (sort_order >= 0),
  CONSTRAINT ck_learning_outcomes_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_learning_outcomes_subject_fk ON app.learning_outcomes (subject_id, school_id);
CREATE INDEX idx_learning_outcomes_grade_level_fk ON app.learning_outcomes (grade_level_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 3. Achievement per student, outcome and period
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.student_outcome_achievements (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_outcome_achievements PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  section_id uuid NOT NULL,
  -- NULL: the whole year rather than one term.
  term_id uuid,
  student_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  outcome_id uuid NOT NULL,
  level smallint NOT NULL,
  entered_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_student_outcome_achievements_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_outcome_achievements_section
    FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_outcome_achievements_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_outcome_achievements_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_outcome_achievements_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_outcome_achievements_outcome FOREIGN KEY (outcome_id, subject_id, school_id)
    REFERENCES app.learning_outcomes (id, subject_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_outcome_achievements_entered_by FOREIGN KEY (entered_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_outcome_achievements_level CHECK (level BETWEEN 1 AND 10),
  CONSTRAINT ck_student_outcome_achievements_timestamps CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX uq_student_outcome_achievements_term
  ON app.student_outcome_achievements (school_id, section_id, term_id, student_id, outcome_id)
  WHERE term_id IS NOT NULL;
CREATE UNIQUE INDEX uq_student_outcome_achievements_annual
  ON app.student_outcome_achievements (school_id, section_id, student_id, outcome_id)
  WHERE term_id IS NULL;
-- A section's sheet for one subject and period.
CREATE INDEX idx_student_outcome_achievements_section_subject
  ON app.student_outcome_achievements (school_id, section_id, subject_id, term_id);
CREATE INDEX idx_student_outcome_achievements_section_fk
  ON app.student_outcome_achievements (section_id, academic_year_id, school_id);
CREATE INDEX idx_student_outcome_achievements_term_fk
  ON app.student_outcome_achievements (term_id, academic_year_id, school_id)
  WHERE term_id IS NOT NULL;
CREATE INDEX idx_student_outcome_achievements_student_fk
  ON app.student_outcome_achievements (student_id, school_id);
CREATE INDEX idx_student_outcome_achievements_subject_fk
  ON app.student_outcome_achievements (subject_id, school_id);
CREATE INDEX idx_student_outcome_achievements_outcome_fk
  ON app.student_outcome_achievements (outcome_id, subject_id, school_id);
CREATE INDEX idx_student_outcome_achievements_entered_by_fk
  ON app.student_outcome_achievements (entered_by_user_id, school_id);

CREATE TABLE app.finalized_outcome_achievements (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_finalized_outcome_achievements PRIMARY KEY,
  school_id uuid NOT NULL,
  finalization_id uuid NOT NULL,
  student_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  outcome_id uuid NOT NULL,
  code text NOT NULL,
  text text NOT NULL,
  text_ar text,
  strand text,
  sort_order integer NOT NULL,
  level smallint NOT NULL,
  label text,
  label_ar text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_finalized_outcome_achievements_outcome
    UNIQUE (school_id, finalization_id, student_id, outcome_id),
  CONSTRAINT fk_finalized_outcome_achievements_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Only a subject the student has a finalized result in carries outcome achievement.
  CONSTRAINT fk_finalized_outcome_achievements_result
    FOREIGN KEY (school_id, finalization_id, student_id, subject_id)
    REFERENCES app.student_subject_results (school_id, finalization_id, student_id, subject_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finalized_outcome_achievements_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finalized_outcome_achievements_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finalized_outcome_achievements_outcome FOREIGN KEY (outcome_id, school_id)
    REFERENCES app.learning_outcomes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_finalized_outcome_achievements_level CHECK (level BETWEEN 1 AND 10)
);

CREATE INDEX idx_finalized_outcome_achievements_student_fk
  ON app.finalized_outcome_achievements (student_id, school_id);
CREATE INDEX idx_finalized_outcome_achievements_subject_fk
  ON app.finalized_outcome_achievements (subject_id, school_id);
CREATE INDEX idx_finalized_outcome_achievements_outcome_fk
  ON app.finalized_outcome_achievements (outcome_id, school_id);
CREATE INDEX idx_finalized_outcome_achievements_result_fk
  ON app.finalized_outcome_achievements (school_id, finalization_id, student_id, subject_id);

-- ---------------------------------------------------------------------------------------------------
-- 4. Term plans
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.term_plans (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_term_plans PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  term_id uuid NOT NULL,
  section_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'draft',
  first_submitted_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by_user_id uuid,
  review_comment text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_term_plans_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_term_plans_section_subject_term UNIQUE (school_id, section_id, subject_id, term_id),
  CONSTRAINT fk_term_plans_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_term_plans_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_term_plans_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_term_plans_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_term_plans_author FOREIGN KEY (author_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_term_plans_reviewed_by FOREIGN KEY (reviewed_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_term_plans_status CHECK (status IN ('draft', 'submitted', 'approved', 'returned')),
  CONSTRAINT ck_term_plans_notes CHECK (notes IS NULL OR char_length(notes) <= 5000),
  CONSTRAINT ck_term_plans_review_comment
    CHECK (review_comment IS NULL OR char_length(review_comment) <= 2000),
  -- A draft was never submitted; anything else was, and a reviewed plan names its reviewer.
  CONSTRAINT ck_term_plans_state CHECK (
    (status = 'draft') = (first_submitted_at IS NULL)
    AND (status = 'draft' OR submitted_at IS NOT NULL)
    AND (status NOT IN ('approved', 'returned')
         OR (reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL))
    AND (status <> 'returned' OR review_comment IS NOT NULL)
  ),
  CONSTRAINT ck_term_plans_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_term_plans_review_queue ON app.term_plans (school_id, academic_year_id, status);
CREATE INDEX idx_term_plans_term_fk ON app.term_plans (term_id, academic_year_id, school_id);
CREATE INDEX idx_term_plans_section_fk ON app.term_plans (section_id, academic_year_id, school_id);
CREATE INDEX idx_term_plans_subject_fk ON app.term_plans (subject_id, school_id);
CREATE INDEX idx_term_plans_author_fk ON app.term_plans (author_user_id, school_id);
CREATE INDEX idx_term_plans_reviewed_by_fk ON app.term_plans (reviewed_by_user_id, school_id)
  WHERE reviewed_by_user_id IS NOT NULL;

CREATE TABLE app.term_plan_weeks (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_term_plan_weeks PRIMARY KEY,
  school_id uuid NOT NULL,
  term_plan_id uuid NOT NULL,
  week_number smallint NOT NULL,
  starts_on date,
  unit text,
  notes text,
  CONSTRAINT uq_term_plan_weeks_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_term_plan_weeks_week UNIQUE (school_id, term_plan_id, week_number),
  CONSTRAINT fk_term_plan_weeks_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_term_plan_weeks_plan FOREIGN KEY (term_plan_id, school_id)
    REFERENCES app.term_plans (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_term_plan_weeks_week CHECK (week_number BETWEEN 1 AND 60),
  CONSTRAINT ck_term_plan_weeks_unit CHECK (unit IS NULL OR char_length(unit) <= 200),
  CONSTRAINT ck_term_plan_weeks_notes CHECK (notes IS NULL OR char_length(notes) <= 2000)
);

CREATE INDEX idx_term_plan_weeks_plan_fk ON app.term_plan_weeks (term_plan_id, school_id);

CREATE TABLE app.term_plan_week_outcomes (
  school_id uuid NOT NULL,
  week_id uuid NOT NULL,
  outcome_id uuid NOT NULL,
  CONSTRAINT pk_term_plan_week_outcomes PRIMARY KEY (school_id, week_id, outcome_id),
  CONSTRAINT fk_term_plan_week_outcomes_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_term_plan_week_outcomes_week FOREIGN KEY (week_id, school_id)
    REFERENCES app.term_plan_weeks (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_term_plan_week_outcomes_outcome FOREIGN KEY (outcome_id, school_id)
    REFERENCES app.learning_outcomes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_term_plan_week_outcomes_week_fk ON app.term_plan_week_outcomes (week_id, school_id);
CREATE INDEX idx_term_plan_week_outcomes_outcome_fk
  ON app.term_plan_week_outcomes (outcome_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 5. Lesson plans
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.lesson_plans (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_lesson_plans PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  -- The term the lesson date falls in, when there is one.
  term_id uuid,
  section_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  lesson_date date NOT NULL,
  -- The timetable period, when the lesson is one of the timetable's.
  period smallint,
  title text NOT NULL,
  objectives text,
  activities text,
  resources text,
  homework text,
  reflection text,
  status text NOT NULL DEFAULT 'draft',
  first_submitted_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by_user_id uuid,
  review_comment text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_lesson_plans_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_lesson_plans_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lesson_plans_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lesson_plans_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lesson_plans_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lesson_plans_author FOREIGN KEY (author_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lesson_plans_reviewed_by FOREIGN KEY (reviewed_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_lesson_plans_period CHECK (period IS NULL OR period BETWEEN 1 AND 20),
  CONSTRAINT ck_lesson_plans_title
    CHECK (title = btrim(title) AND title <> '' AND char_length(title) <= 200),
  CONSTRAINT ck_lesson_plans_objectives CHECK (objectives IS NULL OR char_length(objectives) <= 4000),
  CONSTRAINT ck_lesson_plans_activities CHECK (activities IS NULL OR char_length(activities) <= 4000),
  CONSTRAINT ck_lesson_plans_resources CHECK (resources IS NULL OR char_length(resources) <= 2000),
  CONSTRAINT ck_lesson_plans_homework CHECK (homework IS NULL OR char_length(homework) <= 2000),
  CONSTRAINT ck_lesson_plans_reflection CHECK (reflection IS NULL OR char_length(reflection) <= 2000),
  CONSTRAINT ck_lesson_plans_status CHECK (status IN ('draft', 'submitted', 'approved', 'returned')),
  CONSTRAINT ck_lesson_plans_review_comment
    CHECK (review_comment IS NULL OR char_length(review_comment) <= 2000),
  CONSTRAINT ck_lesson_plans_state CHECK (
    (status = 'draft') = (first_submitted_at IS NULL)
    AND (status = 'draft' OR submitted_at IS NOT NULL)
    AND (status NOT IN ('approved', 'returned')
         OR (reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL))
    AND (status <> 'returned' OR review_comment IS NOT NULL)
  ),
  CONSTRAINT ck_lesson_plans_timestamps CHECK (updated_at >= created_at)
);

-- A section's subject's lessons by date (the teacher's list and the coverage view).
CREATE INDEX idx_lesson_plans_section_subject_date
  ON app.lesson_plans (school_id, section_id, subject_id, lesson_date);
CREATE INDEX idx_lesson_plans_review_queue ON app.lesson_plans (school_id, academic_year_id, status);
CREATE INDEX idx_lesson_plans_term_fk ON app.lesson_plans (term_id, academic_year_id, school_id)
  WHERE term_id IS NOT NULL;
CREATE INDEX idx_lesson_plans_section_fk ON app.lesson_plans (section_id, academic_year_id, school_id);
CREATE INDEX idx_lesson_plans_subject_fk ON app.lesson_plans (subject_id, school_id);
CREATE INDEX idx_lesson_plans_author_fk ON app.lesson_plans (author_user_id, school_id);
CREATE INDEX idx_lesson_plans_reviewed_by_fk ON app.lesson_plans (reviewed_by_user_id, school_id)
  WHERE reviewed_by_user_id IS NOT NULL;

CREATE TABLE app.lesson_plan_outcomes (
  school_id uuid NOT NULL,
  lesson_plan_id uuid NOT NULL,
  outcome_id uuid NOT NULL,
  CONSTRAINT pk_lesson_plan_outcomes PRIMARY KEY (school_id, lesson_plan_id, outcome_id),
  CONSTRAINT fk_lesson_plan_outcomes_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lesson_plan_outcomes_plan FOREIGN KEY (lesson_plan_id, school_id)
    REFERENCES app.lesson_plans (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_lesson_plan_outcomes_outcome FOREIGN KEY (outcome_id, school_id)
    REFERENCES app.learning_outcomes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_lesson_plan_outcomes_plan_fk ON app.lesson_plan_outcomes (lesson_plan_id, school_id);
CREATE INDEX idx_lesson_plan_outcomes_outcome_fk ON app.lesson_plan_outcomes (outcome_id, school_id);

-- The material's title is copied at link time: a reviewer who cannot open the class's materials
-- still sees what was planned. Deleting the material removes the link.
CREATE TABLE app.lesson_plan_materials (
  school_id uuid NOT NULL,
  lesson_plan_id uuid NOT NULL,
  material_id uuid NOT NULL,
  title text NOT NULL,
  CONSTRAINT pk_lesson_plan_materials PRIMARY KEY (school_id, lesson_plan_id, material_id),
  CONSTRAINT fk_lesson_plan_materials_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_lesson_plan_materials_plan FOREIGN KEY (lesson_plan_id, school_id)
    REFERENCES app.lesson_plans (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_lesson_plan_materials_material FOREIGN KEY (material_id, school_id)
    REFERENCES app.materials (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_lesson_plan_materials_title CHECK (btrim(title) <> '')
);

CREATE INDEX idx_lesson_plan_materials_plan_fk ON app.lesson_plan_materials (lesson_plan_id, school_id);
CREATE INDEX idx_lesson_plan_materials_material_fk
  ON app.lesson_plan_materials (material_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 6. Who reads a section's subject work
-- ---------------------------------------------------------------------------------------------------

-- True when the current user is school leadership, teaches the subject in the section, or
-- coordinates it there (000261). Plans and draft achievements are visible to exactly these.
CREATE FUNCTION app.can_read_section_subject_work(target_section_id uuid, target_subject_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR app.teaches_section_subject(target_section_id, target_subject_id)
    OR app.coordinates_section_subject(target_section_id, target_subject_id)
$function$;

ALTER FUNCTION app.can_read_section_subject_work(uuid, uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.can_read_section_subject_work(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_section_subject_work(uuid, uuid) TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 7. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE
  app.academic_planning_settings, app.outcome_achievement_levels, app.learning_outcomes,
  app.student_outcome_achievements, app.finalized_outcome_achievements, app.term_plans,
  app.term_plan_weeks, app.term_plan_week_outcomes, app.lesson_plans, app.lesson_plan_outcomes,
  app.lesson_plan_materials
FROM PUBLIC, studafy_app;

GRANT SELECT, INSERT, UPDATE ON TABLE app.academic_planning_settings TO studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.outcome_achievement_levels, app.learning_outcomes, app.student_outcome_achievements,
  app.term_plans, app.term_plan_weeks, app.term_plan_week_outcomes, app.lesson_plans,
  app.lesson_plan_outcomes, app.lesson_plan_materials
TO studafy_app;
-- The snapshot is append-only, like app.finalized_subject_comments.
GRANT SELECT, INSERT ON TABLE app.finalized_outcome_achievements TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'academic_planning_settings');
SELECT app.apply_tenant_isolation('app', 'outcome_achievement_levels');
SELECT app.apply_tenant_isolation('app', 'learning_outcomes');
SELECT app.apply_tenant_isolation('app', 'student_outcome_achievements');
SELECT app.apply_tenant_isolation('app', 'finalized_outcome_achievements');
SELECT app.apply_tenant_isolation('app', 'term_plans');
SELECT app.apply_tenant_isolation('app', 'term_plan_weeks');
SELECT app.apply_tenant_isolation('app', 'term_plan_week_outcomes');
SELECT app.apply_tenant_isolation('app', 'lesson_plans');
SELECT app.apply_tenant_isolation('app', 'lesson_plan_outcomes');
SELECT app.apply_tenant_isolation('app', 'lesson_plan_materials');

-- Settings, the scale and the catalogue are configuration: tenant isolation only, so a teacher's
-- app shows the outcomes and levels it picks from.

CREATE POLICY role_scope_visibility ON app.student_outcome_achievements
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_section_subject_work(section_id, subject_id));

CREATE POLICY role_scope_visibility ON app.finalized_outcome_achievements
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    app.can_read_student_result(student_id, finalization_id)
    OR app.coordinates_result_subject(finalization_id, subject_id)
  );

CREATE POLICY role_scope_visibility ON app.term_plans
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_section_subject_work(section_id, subject_id));

CREATE POLICY role_scope_visibility ON app.lesson_plans
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_section_subject_work(section_id, subject_id));

-- A plan's parts follow the plan: the subquery reads the plan under the caller's own policies.
CREATE POLICY role_scope_visibility ON app.term_plan_weeks
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    EXISTS (
      SELECT 1 FROM app.term_plans AS plan
      WHERE plan.id = term_plan_weeks.term_plan_id AND plan.school_id = term_plan_weeks.school_id
    )
  );

CREATE POLICY role_scope_visibility ON app.term_plan_week_outcomes
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    EXISTS (
      SELECT 1 FROM app.term_plan_weeks AS week
      WHERE week.id = term_plan_week_outcomes.week_id
        AND week.school_id = term_plan_week_outcomes.school_id
    )
  );

CREATE POLICY role_scope_visibility ON app.lesson_plan_outcomes
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    EXISTS (
      SELECT 1 FROM app.lesson_plans AS plan
      WHERE plan.id = lesson_plan_outcomes.lesson_plan_id
        AND plan.school_id = lesson_plan_outcomes.school_id
    )
  );

CREATE POLICY role_scope_visibility ON app.lesson_plan_materials
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    EXISTS (
      SELECT 1 FROM app.lesson_plans AS plan
      WHERE plan.id = lesson_plan_materials.lesson_plan_id
        AND plan.school_id = lesson_plan_materials.school_id
    )
  );

COMMENT ON TABLE app.academic_planning_settings IS
  'Per school: outcome achievement on report cards and when lesson and term plans are due (000268). No row: the defaults.';
COMMENT ON TABLE app.outcome_achievement_levels IS
  'The school''s learning outcome achievement scale, 1 = lowest (000268). No rows: the default four.';
COMMENT ON TABLE app.learning_outcomes IS
  'Learning outcomes catalogue per subject and grade level (000268).';
COMMENT ON TABLE app.student_outcome_achievements IS
  'A student''s achievement level on a learning outcome for a term or the year, entered by the subject teacher (000268).';
COMMENT ON TABLE app.finalized_outcome_achievements IS
  'Append-only snapshot of outcome achievement copied at finalization for report cards (000268).';
COMMENT ON TABLE app.term_plans IS
  'A section and subject''s plan for a term, reviewed by the subject coordinator or leadership (000268).';
COMMENT ON TABLE app.term_plan_weeks IS 'The weeks of a term plan (000268).';
COMMENT ON TABLE app.term_plan_week_outcomes IS 'The learning outcomes a term plan week covers (000268).';
COMMENT ON TABLE app.lesson_plans IS
  'A daily lesson plan for a section and subject, reviewed by the subject coordinator or leadership (000268).';
COMMENT ON TABLE app.lesson_plan_outcomes IS 'The learning outcomes a lesson plan covers (000268).';
COMMENT ON TABLE app.lesson_plan_materials IS
  'The uploaded class materials a lesson plan uses, with the title as linked (000268).';

RESET ROLE;
