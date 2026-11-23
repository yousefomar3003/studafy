-- External exams and test scores (docs/plans/curriculum-support.md, WS-D): SAT, ACT, AP, IELTS,
-- TOEFL, IGCSE / A-Level / IB final results and any exam a school defines itself.
--
-- THE CATALOGUE. app.external_exams is a school's list of the external exams its students sit, and
-- app.external_exam_components the parts each one is scored on (SAT: Reading and Writing, Math;
-- IELTS: four bands; AP: one score). Built-in presets live in code (packages/grading-engine,
-- external-exams.ts); adding one copies it into these tables, after which it is the school's own
-- and editable. An exam is archived, never deleted: results keep pointing at it.
--
-- A component is scored either as a number (min, max, step: IELTS 0..9 by 0.5) or as one label
-- out of an ordered list (IGCSE A*..U). The exam's total is `sum` or `average` of its numeric
-- components (an average optionally rounded to a step: the IELTS overall band rounds to 0.5), or
-- `none`. A `per_subject` exam (IGCSE, A-Level, IB DP, AP) has one result per subject.
--
-- RESULTS. app.student_external_exam_results is one sitting of one exam by one student (optionally
-- for one subject), with the total the API computed when it was recorded; one
-- app.student_external_exam_scores row per component scored. Composite foreign keys hold every
-- score to a component of the result's own exam and to the result's student, so a score can never
-- belong to another exam or another student. Scores are recorded by school leadership; the API
-- validates them against the component (range, step, allowed labels).
--
-- VISIBILITY. The catalogue is configuration, not personal data: tenant isolation only. Results and
-- scores are a student's personal data and follow app.can_read_student (leadership, a teacher of
-- the student, the student, linked parents) through a restrictive SELECT policy. The GDPR pipeline
-- finds them by their student_id column (apps/workers/src/queues/maintenance/tenant-tables.ts).
--
-- TRANSCRIPTS. Exams with show_on_transcript are copied into a transcript's content when it is
-- issued (000207 transcripts stay immutable); nothing here is read live by an issued document.
--
-- Depends on 000008 (students, users), 000009 (subjects), 000006 (tenant helpers), 000037
-- (app.can_read_student).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. The catalogue
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.external_exams (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_external_exams PRIMARY KEY,
  school_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  -- The built-in preset this exam was copied from (sat, ielts...), NULL for a custom exam.
  preset_key text,
  total_mode text NOT NULL DEFAULT 'none',
  -- An `average` total rounded to the nearest multiple of this step (IELTS: 0.5).
  total_rounding_step numeric(6, 3),
  total_min numeric(8, 2),
  total_max numeric(8, 2),
  per_subject boolean NOT NULL DEFAULT false,
  show_on_transcript boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_external_exams_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_external_exams_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_external_exams_code CHECK (
    code = btrim(code) AND code <> '' AND char_length(code) <= 40
  ),
  CONSTRAINT ck_external_exams_name CHECK (
    name = btrim(name) AND name <> '' AND char_length(name) <= 120
  ),
  CONSTRAINT ck_external_exams_preset_key CHECK (
    preset_key IS NULL OR preset_key ~ '^[a-z0-9_]{1,40}$'
  ),
  CONSTRAINT ck_external_exams_total_mode CHECK (total_mode IN ('sum', 'average', 'none')),
  -- Only an average is rounded to a step; an exam without a total has no total range.
  CONSTRAINT ck_external_exams_total_rounding CHECK (
    total_rounding_step IS NULL OR (total_mode = 'average' AND total_rounding_step > 0)
  ),
  CONSTRAINT ck_external_exams_total_range CHECK (
    (total_mode <> 'none' OR (total_min IS NULL AND total_max IS NULL))
    AND (total_min IS NULL OR total_max IS NULL OR total_min <= total_max)
  ),
  CONSTRAINT ck_external_exams_timestamps CHECK (updated_at >= created_at)
);

-- Codes are unique within a school, whatever their case ("SAT" and "sat" are the same exam).
CREATE UNIQUE INDEX uq_external_exams_school_code ON app.external_exams (school_id, lower(code));
-- The catalogue as listed (by name). Also the plain school_id-leading index the RLS path needs: an
-- expression index does not count (db/policies/rls-coverage.ts, SCHOOL_LEADING_INDEX).
CREATE INDEX idx_external_exams_school_name ON app.external_exams (school_id, name);

CREATE TABLE app.external_exam_components (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_external_exam_components PRIMARY KEY,
  school_id uuid NOT NULL,
  exam_id uuid NOT NULL,
  name text NOT NULL,
  score_type text NOT NULL,
  min_score numeric(8, 2),
  max_score numeric(8, 2),
  step numeric(6, 3),
  -- The allowed labels, best first (A*, A, B...). An ordered, closed list read whole with the
  -- component and never joined or filtered on (approved in db/policies/rls-coverage.ts).
  allowed_labels text[],
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_external_exam_components_exam_name UNIQUE (school_id, exam_id, name),
  CONSTRAINT uq_external_exam_components_id_exam_school UNIQUE (id, exam_id, school_id),
  CONSTRAINT fk_external_exam_components_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_external_exam_components_exam FOREIGN KEY (exam_id, school_id)
    REFERENCES app.external_exams (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_external_exam_components_name CHECK (
    name = btrim(name) AND name <> '' AND char_length(name) <= 120
  ),
  CONSTRAINT ck_external_exam_components_score_type CHECK (score_type IN ('numeric', 'label')),
  CONSTRAINT ck_external_exam_components_numeric CHECK (
    score_type <> 'numeric' OR (
      min_score IS NOT NULL AND max_score IS NOT NULL AND step IS NOT NULL
      AND min_score < max_score AND step > 0 AND allowed_labels IS NULL
    )
  ),
  CONSTRAINT ck_external_exam_components_label CHECK (
    score_type <> 'label' OR (
      min_score IS NULL AND max_score IS NULL AND step IS NULL
      AND allowed_labels IS NOT NULL
      AND cardinality(allowed_labels) BETWEEN 1 AND 50
      AND array_position(allowed_labels, NULL) IS NULL
    )
  ),
  CONSTRAINT ck_external_exam_components_sort_order CHECK (sort_order >= 0),
  CONSTRAINT ck_external_exam_components_timestamps CHECK (updated_at >= created_at)
);

-- uq_external_exam_components_exam_name's (school_id, exam_id, ...) prefix does not serve the
-- (exam_id, school_id) foreign key; loading an exam's components reads by it.
CREATE INDEX idx_external_exam_components_exam_fk
  ON app.external_exam_components (exam_id, school_id, sort_order);

-- ---------------------------------------------------------------------------------------------------
-- 2. A student's results
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.student_external_exam_results (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_external_exam_results PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  exam_id uuid NOT NULL,
  -- Set for a per-subject exam (IGCSE Mathematics); NULL otherwise. The API enforces which.
  subject_id uuid,
  sat_on date NOT NULL,
  -- Computed by the API from the component scores and the exam's total mode when recorded; NULL
  -- when the exam has no total or a component of it was not scored.
  total_score numeric(8, 2),
  note text,
  recorded_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_student_external_exam_results_id_student_exam_school
    UNIQUE (id, student_id, exam_id, school_id),
  CONSTRAINT fk_student_external_exam_results_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_external_exam_results_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_external_exam_results_exam FOREIGN KEY (exam_id, school_id)
    REFERENCES app.external_exams (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_external_exam_results_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_external_exam_results_recorded_by FOREIGN KEY (recorded_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_external_exam_results_sat_on CHECK (sat_on >= DATE '1950-01-01'),
  CONSTRAINT ck_student_external_exam_results_note CHECK (
    note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 1000)
  ),
  CONSTRAINT ck_student_external_exam_results_timestamps CHECK (updated_at >= created_at)
);

-- A student's results, newest sitting first (the student overview, the apps, transcripts).
CREATE INDEX idx_student_external_exam_results_student
  ON app.student_external_exam_results (school_id, student_id, sat_on DESC);
CREATE INDEX idx_student_external_exam_results_student_fk
  ON app.student_external_exam_results (student_id, school_id);
-- Whether an exam has results (its scoring rules lock) and the exam foreign key's checks.
CREATE INDEX idx_student_external_exam_results_exam_fk
  ON app.student_external_exam_results (exam_id, school_id);
CREATE INDEX idx_student_external_exam_results_subject_fk
  ON app.student_external_exam_results (subject_id, school_id) WHERE subject_id IS NOT NULL;
CREATE INDEX idx_student_external_exam_results_recorded_by_fk
  ON app.student_external_exam_results (recorded_by_user_id, school_id);

CREATE TABLE app.student_external_exam_scores (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_external_exam_scores PRIMARY KEY,
  school_id uuid NOT NULL,
  result_id uuid NOT NULL,
  -- Carried so the score's visibility follows its student without a join, and so the GDPR
  -- pipeline reaches it by student_id; the composite key below holds it equal to the result's.
  student_id uuid NOT NULL,
  exam_id uuid NOT NULL,
  component_id uuid NOT NULL,
  numeric_score numeric(8, 2),
  label_score text,
  CONSTRAINT uq_student_external_exam_scores_result_component
    UNIQUE (school_id, result_id, component_id),
  CONSTRAINT fk_student_external_exam_scores_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Deleting a result deletes its scores with it.
  CONSTRAINT fk_student_external_exam_scores_result
    FOREIGN KEY (result_id, student_id, exam_id, school_id)
    REFERENCES app.student_external_exam_results (id, student_id, exam_id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  -- A component of the result's own exam; a scored component cannot be removed from the exam.
  CONSTRAINT fk_student_external_exam_scores_component FOREIGN KEY (component_id, exam_id, school_id)
    REFERENCES app.external_exam_components (id, exam_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_external_exam_scores_one_value CHECK (
    (numeric_score IS NULL) <> (label_score IS NULL)
  ),
  CONSTRAINT ck_student_external_exam_scores_label CHECK (
    label_score IS NULL OR (label_score = btrim(label_score) AND label_score <> ''
      AND char_length(label_score) <= 40)
  )
);

CREATE INDEX idx_student_external_exam_scores_result_fk
  ON app.student_external_exam_scores (result_id, student_id, exam_id, school_id);
CREATE INDEX idx_student_external_exam_scores_component_fk
  ON app.student_external_exam_scores (component_id, exam_id, school_id);

COMMENT ON TABLE app.external_exams IS
  'A school''s catalogue of external exams (SAT, IELTS, IGCSE final...) and how each is totalled (000255); archived, never deleted.';
COMMENT ON TABLE app.external_exam_components IS
  'The parts an external exam is scored on, numeric (min/max/step) or one of an ordered list of labels (000255).';
COMMENT ON TABLE app.student_external_exam_results IS
  'One sitting of an external exam by a student, optionally for one subject, with its computed total (000255).';
COMMENT ON TABLE app.student_external_exam_scores IS
  'A result''s score in one component of its exam (000255); deleted with the result.';
COMMENT ON COLUMN app.external_exams.show_on_transcript IS
  'Copy this exam''s results into a transcript''s external examinations section when it is issued (000255).';
COMMENT ON COLUMN app.student_external_exam_results.total_score IS
  'Computed by the API from the scores and the exam''s total mode when recorded or edited (000255).';

-- ---------------------------------------------------------------------------------------------------
-- 3. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

-- 000002's default privileges grant studafy_app full DML on new tables; take it back from it and
-- PUBLIC, then grant exactly what the API needs. Exams are archived, not deleted; components and
-- results are deleted by leadership through the API.
REVOKE ALL PRIVILEGES ON TABLE
  app.external_exams, app.external_exam_components, app.student_external_exam_results,
  app.student_external_exam_scores
FROM PUBLIC, studafy_app;

GRANT SELECT, INSERT, UPDATE ON TABLE app.external_exams TO studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.external_exam_components, app.student_external_exam_results, app.student_external_exam_scores
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'external_exams');
SELECT app.apply_tenant_isolation('app', 'external_exam_components');
SELECT app.apply_tenant_isolation('app', 'student_external_exam_results');
SELECT app.apply_tenant_isolation('app', 'student_external_exam_scores');

CREATE POLICY role_scope_visibility ON app.student_external_exam_results
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(student_id));

CREATE POLICY role_scope_visibility ON app.student_external_exam_scores
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(student_id));

RESET ROLE;
