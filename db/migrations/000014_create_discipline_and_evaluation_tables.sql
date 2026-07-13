-- Creates the school-owned discipline incident/action model and teacher evaluation tables.
-- discipline_incidents requires a reporter_user_id; discipline_actions track responses to
-- incidents. teacher_evaluations are scoped to the evaluated teacher via a RESTRICTIVE RLS
-- policy that ANDs with canonical tenant isolation. The app.current_user_id() function
-- supports the restrictive policy and requires the application to set both app.school_id
-- and app.user_id per transaction.

SET ROLE studafy_admin;

CREATE TYPE app.discipline_incident_type AS ENUM (
  'behavioral', 'academic_integrity', 'attendance', 'bullying',
  'substance', 'vandalism', 'safety', 'other'
);
CREATE TYPE app.discipline_severity AS ENUM (
  'minor', 'moderate', 'major', 'critical'
);
CREATE TYPE app.discipline_incident_status AS ENUM (
  'reported', 'under_review', 'resolved', 'escalated', 'closed'
);
CREATE TYPE app.discipline_action_type AS ENUM (
  'verbal_warning', 'written_warning', 'detention', 'in_school_suspension',
  'out_of_school_suspension', 'expulsion', 'parent_meeting',
  'counseling_referral', 'community_service', 'other'
);
CREATE TYPE app.discipline_action_status AS ENUM (
  'pending', 'active', 'completed', 'revoked'
);
CREATE TYPE app.evaluation_type AS ENUM (
  'formal_observation', 'peer_review', 'self_assessment',
  'student_feedback', 'annual_review', 'probationary_review'
);
CREATE TYPE app.evaluation_rating AS ENUM (
  'unsatisfactory', 'developing', 'proficient', 'exemplary'
);
CREATE TYPE app.evaluation_status AS ENUM (
  'draft', 'submitted', 'finalized'
);

-- Returns the current application user from the session variable app.user_id.
-- Used by the teacher_evaluation_visibility restrictive RLS policy.
-- The application must SET LOCAL app.user_id alongside app.school_id per transaction.
CREATE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT current_setting('app.user_id')::uuid
$function$;

ALTER FUNCTION app.current_user_id() OWNER TO studafy_admin;

CREATE TABLE app.discipline_incidents (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_discipline_incidents PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  class_id uuid,
  reporter_user_id uuid NOT NULL,
  incident_type app.discipline_incident_type NOT NULL,
  severity app.discipline_severity NOT NULL,
  status app.discipline_incident_status NOT NULL DEFAULT 'reported',
  title text NOT NULL,
  description text,
  incident_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_discipline_incidents_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_discipline_incidents_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_discipline_incidents_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_discipline_incidents_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_discipline_incidents_reporter FOREIGN KEY (reporter_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_discipline_incidents_title CHECK (
    title = btrim(title) AND title <> ''
  ),
  CONSTRAINT ck_discipline_incidents_description CHECK (
    description IS NULL OR (description = btrim(description) AND description <> '')
  ),
  CONSTRAINT ck_discipline_incidents_resolved_at CHECK (
    resolved_at IS NULL OR resolved_at >= created_at
  ),
  CONSTRAINT ck_discipline_incidents_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.discipline_actions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_discipline_actions PRIMARY KEY,
  school_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  action_type app.discipline_action_type NOT NULL,
  action_by_user_id uuid NOT NULL,
  status app.discipline_action_status NOT NULL DEFAULT 'pending',
  description text,
  effective_from date,
  effective_until date,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_discipline_actions_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_discipline_actions_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_discipline_actions_incident FOREIGN KEY (incident_id, school_id)
    REFERENCES app.discipline_incidents (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_discipline_actions_action_by FOREIGN KEY (action_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_discipline_actions_description CHECK (
    description IS NULL OR (description = btrim(description) AND description <> '')
  ),
  CONSTRAINT ck_discipline_actions_dates CHECK (
    effective_until IS NULL OR effective_from IS NULL OR effective_until >= effective_from
  ),
  CONSTRAINT ck_discipline_actions_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.teacher_evaluations (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_teacher_evaluations PRIMARY KEY,
  school_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  evaluator_user_id uuid NOT NULL,
  class_id uuid,
  evaluation_type app.evaluation_type NOT NULL,
  rating app.evaluation_rating,
  strengths text,
  areas_for_improvement text,
  comments text,
  status app.evaluation_status NOT NULL DEFAULT 'draft',
  evaluated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_teacher_evaluations_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_teacher_evaluations_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_teacher_evaluations_teacher FOREIGN KEY (teacher_id, school_id)
    REFERENCES app.teachers (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_teacher_evaluations_evaluator FOREIGN KEY (evaluator_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_teacher_evaluations_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_teacher_evaluations_strengths CHECK (
    strengths IS NULL OR (strengths = btrim(strengths) AND strengths <> '')
  ),
  CONSTRAINT ck_teacher_evaluations_areas_for_improvement CHECK (
    areas_for_improvement IS NULL
    OR (areas_for_improvement = btrim(areas_for_improvement) AND areas_for_improvement <> '')
  ),
  CONSTRAINT ck_teacher_evaluations_comments CHECK (
    comments IS NULL OR (comments = btrim(comments) AND comments <> '')
  ),
  CONSTRAINT ck_teacher_evaluations_timestamps CHECK (updated_at >= created_at)
);

-- Indexes: school_id leading for RLS predicate; appended id for tie-breaking.
-- Each index serves a documented list/queue/audit query or backs a composite FK.

CREATE INDEX idx_discipline_incidents_school_student_id
  ON app.discipline_incidents (school_id, student_id, id);
CREATE INDEX idx_discipline_incidents_school_class_id
  ON app.discipline_incidents (school_id, class_id, id);
CREATE INDEX idx_discipline_incidents_school_reporter_user_id
  ON app.discipline_incidents (school_id, reporter_user_id, id);
CREATE INDEX idx_discipline_incidents_school_status_incident_at
  ON app.discipline_incidents (school_id, status, incident_at, id);

CREATE INDEX idx_discipline_actions_school_incident_id
  ON app.discipline_actions (school_id, incident_id, id);
CREATE INDEX idx_discipline_actions_school_action_by_user_id
  ON app.discipline_actions (school_id, action_by_user_id, id);
CREATE INDEX idx_discipline_actions_school_status
  ON app.discipline_actions (school_id, status, id);

CREATE INDEX idx_teacher_evaluations_school_teacher_id
  ON app.teacher_evaluations (school_id, teacher_id, id);
CREATE INDEX idx_teacher_evaluations_school_evaluator_user_id
  ON app.teacher_evaluations (school_id, evaluator_user_id, id);
CREATE INDEX idx_teacher_evaluations_school_class_id
  ON app.teacher_evaluations (school_id, class_id, id);
CREATE INDEX idx_teacher_evaluations_school_status
  ON app.teacher_evaluations (school_id, status, id);

-- Grants: explicit DML for runtime, revoke PUBLIC on types and function.

REVOKE ALL PRIVILEGES ON TABLE
  app.discipline_incidents, app.discipline_actions, app.teacher_evaluations
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.discipline_incidents, app.discipline_actions, app.teacher_evaluations
TO studafy_app;

REVOKE ALL ON TYPE
  app.discipline_incident_type, app.discipline_severity, app.discipline_incident_status,
  app.discipline_action_type, app.discipline_action_status,
  app.evaluation_type, app.evaluation_rating, app.evaluation_status
FROM PUBLIC;
GRANT USAGE ON TYPE
  app.discipline_incident_type, app.discipline_severity, app.discipline_incident_status,
  app.discipline_action_type, app.discipline_action_status,
  app.evaluation_type, app.evaluation_rating, app.evaluation_status
TO studafy_app;

GRANT EXECUTE ON FUNCTION app.current_user_id() TO studafy_app;

-- Tenant isolation: canonical permissive FOR ALL policy on all three tables.

SELECT app.apply_tenant_isolation('app', 'discipline_incidents');
SELECT app.apply_tenant_isolation('app', 'discipline_actions');
SELECT app.apply_tenant_isolation('app', 'teacher_evaluations');

-- Evaluation visibility: RESTRICTIVE SELECT policy that ANDs with tenant_isolation.
-- Limits evaluation reads to the evaluated teacher and the evaluator.
-- Requires app.user_id to be set via SET LOCAL alongside app.school_id.
CREATE POLICY teacher_evaluation_visibility ON app.teacher_evaluations
  AS RESTRICTIVE FOR SELECT TO PUBLIC
  USING (
    teacher_id IN (
      SELECT t.id FROM app.teachers t
      WHERE t.user_id = app.current_user_id()
        AND t.school_id = current_setting('app.school_id')::uuid
    )
    OR evaluator_user_id = app.current_user_id()
  );

RESET ROLE;
