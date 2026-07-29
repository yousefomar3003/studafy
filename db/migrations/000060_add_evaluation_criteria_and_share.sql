-- Creates evaluation criteria templates and scores tables, adds share-with-teacher
-- columns to teacher_evaluations, and tightens the RLS policy so teachers can only
-- see evaluations when shared_with_teacher = true.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- 1. Extend teacher_evaluations
-- ---------------------------------------------------------------------------

ALTER TABLE app.teacher_evaluations
  ADD COLUMN shared_with_teacher boolean NOT NULL DEFAULT false,
  ADD COLUMN shared_at timestamptz,
  ADD COLUMN narrative text;

ALTER TABLE app.teacher_evaluations
  ADD CONSTRAINT ck_teacher_evaluations_narrative CHECK (
    narrative IS NULL OR (narrative = btrim(narrative) AND narrative <> '')
  ),
  ADD CONSTRAINT ck_teacher_evaluations_shared_at CHECK (
    shared_at IS NULL OR shared_at >= created_at
  );

-- ---------------------------------------------------------------------------
-- 2. Evaluation criteria templates
-- ---------------------------------------------------------------------------

CREATE TABLE app.evaluation_criteria_templates (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_evaluation_criteria_templates PRIMARY KEY,
  school_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  max_score numeric(5,2) NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_evaluation_criteria_templates_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_evaluation_criteria_templates_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_evaluation_criteria_templates_title CHECK (
    title = btrim(title) AND title <> ''
  ),
  CONSTRAINT ck_evaluation_criteria_templates_max_score CHECK (max_score > 0),
  CONSTRAINT ck_evaluation_criteria_templates_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_evaluation_criteria_templates_school_active
  ON app.evaluation_criteria_templates (school_id, is_active, sort_order, id);

-- ---------------------------------------------------------------------------
-- 3. Evaluation scores
-- ---------------------------------------------------------------------------

CREATE TABLE app.evaluation_scores (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_evaluation_scores PRIMARY KEY,
  school_id uuid NOT NULL,
  evaluation_id uuid NOT NULL,
  criteria_template_id uuid NOT NULL,
  score numeric(5,2) NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_evaluation_scores_evaluation_criteria UNIQUE (evaluation_id, criteria_template_id),
  CONSTRAINT uq_evaluation_scores_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_evaluation_scores_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_evaluation_scores_evaluation FOREIGN KEY (evaluation_id, school_id)
    REFERENCES app.teacher_evaluations (id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_evaluation_scores_criteria_template FOREIGN KEY (criteria_template_id, school_id)
    REFERENCES app.evaluation_criteria_templates (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_evaluation_scores_score CHECK (score >= 0),
  CONSTRAINT ck_evaluation_scores_comment CHECK (
    comment IS NULL OR (comment = btrim(comment) AND comment <> '')
  ),
  CONSTRAINT ck_evaluation_scores_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_evaluation_scores_evaluation
  ON app.evaluation_scores (school_id, evaluation_id, id);
CREATE INDEX idx_evaluation_scores_criteria_template
  ON app.evaluation_scores (school_id, criteria_template_id, id);

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE
  app.evaluation_criteria_templates, app.evaluation_scores
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.evaluation_criteria_templates, app.evaluation_scores
TO studafy_app;

-- ---------------------------------------------------------------------------
-- 5. Tenant isolation for new tables
-- ---------------------------------------------------------------------------

SELECT app.apply_tenant_isolation('app', 'evaluation_criteria_templates');
SELECT app.apply_tenant_isolation('app', 'evaluation_scores');

-- ---------------------------------------------------------------------------
-- 6. Tighten evaluation visibility RLS — teacher must have shared_with_teacher = true
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS teacher_evaluation_visibility ON app.teacher_evaluations;

CREATE POLICY teacher_evaluation_visibility ON app.teacher_evaluations
  AS RESTRICTIVE FOR SELECT TO PUBLIC
  USING (
    (teacher_id IN (
      SELECT t.id FROM app.teachers t
      WHERE t.user_id = app.current_user_id()
        AND t.school_id = current_setting('app.school_id')::uuid
    ) AND shared_with_teacher = true)
    OR evaluator_user_id = app.current_user_id()
  );

RESET ROLE;
