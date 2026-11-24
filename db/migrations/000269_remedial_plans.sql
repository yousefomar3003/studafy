-- Remedial plans (docs/plans/academic-phase2.md, WS-P): a plan to help a struggling student catch up
-- in one subject, for a term or the whole year.
--
--   app.school_settings.remedial_plans_family_visible  the school lets teachers share plans with the
--                                                     student and their linked parents. Off by default:
--                                                     a plan is staff-only until the school opts in AND
--                                                     the plan itself is shared.
--   app.remedial_plans                                 one plan per student, subject and period: why
--                                                     (below the pass line, or the teacher's concern),
--                                                     the target skills or outcomes, the actions and
--                                                     the status open -> in_progress -> achieved / closed.
--   app.remedial_plan_reviews                          the plan's review dates. A review is done once
--                                                     someone following the plan adds a note on or after
--                                                     its date; a past review not done is overdue.
--   app.remedial_plan_notes                            the plan's timeline: progress and follow-up notes
--                                                     and status changes, append-only. A note marked
--                                                     internal is for staff only.
--   app.remedial_plan_outcomes                         EXTENSION POINT, empty for now: the learning
--                                                     outcomes a plan targets, for WS-O (000268).
--
-- A plan belongs to the section the student was in when it was opened: the section's teachers of the
-- subject write it; the subject's coordinator for that section (000261) and school leadership follow
-- it up (read and add notes). Only one plan per student, subject and period is active (open or
-- in_progress) at a time; achieved and closed plans are history.
--
-- Targets are free text for now. app.remedial_plan_outcomes is the reserved extension point for
-- linking the learning outcomes catalogue of WS-O (000268): nothing writes it yet, and outcome_id has
-- no foreign key because that catalogue does not exist on this branch (WS-O adds the key). A plan with
-- no rows there simply has no linked outcomes.
--
-- PRIVACY. Staff: leadership, the section's teachers of the subject and the subject's coordinator.
-- The student and their linked parents read a plan only while the school allows it and the plan is
-- shared, and never an internal note (app.can_read_remedial_plan, app.can_read_remedial_plan_note).
-- Remedial plans are not results: finalization, report cards, certificates and transcripts never read
-- them (ADR-017 untouched).
--
-- Additive only (docs/database/migration-policy.md): one column with a default, two tables and their
-- helpers. No existing function or policy changes; the subject's name reaches a family that may read
-- a plan through app.remedial_plan_subject_name rather than a wider app.can_read_subject.
--
-- Depends on 000009 (years, terms, subjects), 000039 (school settings), 000037 (role-scope helpers),
-- 000147 (sections, placements), 000160 (app.teaches_section_subject) and 000261
-- (app.coordinates_section_subject).

SET ROLE studafy_admin;

ALTER TABLE app.school_settings
  ADD COLUMN remedial_plans_family_visible boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app.school_settings.remedial_plans_family_visible IS
  'Whether teachers may share remedial plans with the student and linked parents (000269).';

-- ---------------------------------------------------------------------------------------------------
-- 1. Plans
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.remedial_plans (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_remedial_plans PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  -- NULL: the plan covers the whole year rather than one term.
  term_id uuid,
  -- The section the student was placed in when the plan was opened (who teaches and coordinates it).
  section_id uuid NOT NULL,
  student_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  reason text NOT NULL,
  reason_note text,
  -- The student's current (or provisional) percentage and the subject's pass line when opened.
  start_percentage numeric(6, 2),
  pass_percentage numeric(5, 2),
  targets text NOT NULL,
  actions text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  shared_with_family boolean NOT NULL DEFAULT false,
  created_by_user_id uuid NOT NULL,
  updated_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_remedial_plans_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_remedial_plans_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plans_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plans_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plans_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plans_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plans_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plans_created_by FOREIGN KEY (created_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plans_updated_by FOREIGN KEY (updated_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_remedial_plans_reason CHECK (reason IN ('below_pass', 'teacher_concern')),
  CONSTRAINT ck_remedial_plans_reason_note
    CHECK (reason_note IS NULL OR (btrim(reason_note) <> '' AND char_length(reason_note) <= 1000)),
  CONSTRAINT ck_remedial_plans_percentages CHECK (
    (start_percentage IS NULL OR start_percentage BETWEEN 0 AND 100)
    AND (pass_percentage IS NULL OR pass_percentage BETWEEN 0 AND 100)
  ),
  CONSTRAINT ck_remedial_plans_targets
    CHECK (btrim(targets) <> '' AND char_length(targets) <= 2000),
  CONSTRAINT ck_remedial_plans_actions
    CHECK (btrim(actions) <> '' AND char_length(actions) <= 4000),
  CONSTRAINT ck_remedial_plans_status
    CHECK (status IN ('open', 'in_progress', 'achieved', 'closed')),
  CONSTRAINT ck_remedial_plans_timestamps CHECK (updated_at >= created_at)
);

-- One active plan per student, subject and period: per term, and once for the year.
CREATE UNIQUE INDEX uq_remedial_plans_active_term
  ON app.remedial_plans (school_id, academic_year_id, term_id, student_id, subject_id)
  WHERE term_id IS NOT NULL AND status IN ('open', 'in_progress');
CREATE UNIQUE INDEX uq_remedial_plans_active_annual
  ON app.remedial_plans (school_id, academic_year_id, student_id, subject_id)
  WHERE term_id IS NULL AND status IN ('open', 'in_progress');
-- Leadership's list (year, status) and a section's subject (the teacher's and coordinator's view).
CREATE INDEX idx_remedial_plans_school_year_status
  ON app.remedial_plans (school_id, academic_year_id, status);
CREATE INDEX idx_remedial_plans_school_section_subject
  ON app.remedial_plans (school_id, section_id, subject_id);
-- A student's plans across years (the student and parent apps).
CREATE INDEX idx_remedial_plans_school_student
  ON app.remedial_plans (school_id, student_id, academic_year_id);
CREATE INDEX idx_remedial_plans_year_fk ON app.remedial_plans (academic_year_id, school_id);
CREATE INDEX idx_remedial_plans_term_fk
  ON app.remedial_plans (term_id, academic_year_id, school_id) WHERE term_id IS NOT NULL;
CREATE INDEX idx_remedial_plans_section_fk
  ON app.remedial_plans (section_id, academic_year_id, school_id);
CREATE INDEX idx_remedial_plans_student_fk ON app.remedial_plans (student_id, school_id);
CREATE INDEX idx_remedial_plans_subject_fk ON app.remedial_plans (subject_id, school_id);
CREATE INDEX idx_remedial_plans_created_by_fk ON app.remedial_plans (created_by_user_id, school_id);
CREATE INDEX idx_remedial_plans_updated_by_fk ON app.remedial_plans (updated_by_user_id, school_id);

COMMENT ON TABLE app.remedial_plans IS
  'A remedial plan for a student in a subject, for a term or the year: reason, targets, actions, review dates and status (000269).';

CREATE TABLE app.remedial_plan_reviews (
  school_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  review_on date NOT NULL,
  -- Set when someone following the plan adds a note on or after review_on (school-local date).
  completed_at timestamptz,
  CONSTRAINT pk_remedial_plan_reviews PRIMARY KEY (school_id, plan_id, review_on),
  CONSTRAINT fk_remedial_plan_reviews_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plan_reviews_plan FOREIGN KEY (plan_id, school_id)
    REFERENCES app.remedial_plans (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE INDEX idx_remedial_plan_reviews_plan_fk ON app.remedial_plan_reviews (plan_id, school_id);
-- Overdue reviews: the reviews not done yet, by date.
CREATE INDEX idx_remedial_plan_reviews_pending
  ON app.remedial_plan_reviews (school_id, review_on) WHERE completed_at IS NULL;

COMMENT ON TABLE app.remedial_plan_reviews IS
  'A remedial plan''s review dates; done once a follow-up note is added on or after the date (000269).';

-- EXTENSION POINT for WS-O (000268): the learning outcomes a plan targets. Reserved and empty: the API
-- does not write it yet. WS-O adds the foreign key from outcome_id to its outcomes catalogue.
CREATE TABLE app.remedial_plan_outcomes (
  school_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  outcome_id uuid NOT NULL,
  CONSTRAINT pk_remedial_plan_outcomes PRIMARY KEY (school_id, plan_id, outcome_id),
  CONSTRAINT fk_remedial_plan_outcomes_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plan_outcomes_plan FOREIGN KEY (plan_id, school_id)
    REFERENCES app.remedial_plans (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE INDEX idx_remedial_plan_outcomes_plan_fk ON app.remedial_plan_outcomes (plan_id, school_id);

COMMENT ON TABLE app.remedial_plan_outcomes IS
  'Reserved for WS-O (000268): the learning outcomes a remedial plan targets. Not written yet (000269).';

-- ---------------------------------------------------------------------------------------------------
-- 2. Timeline
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.remedial_plan_notes (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_remedial_plan_notes PRIMARY KEY,
  school_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  -- note: a progress or follow-up note. status_change: the plan moved to new_status (body optional).
  kind text NOT NULL DEFAULT 'note',
  body text,
  new_status text,
  -- Staff only: never shown to the student or parents.
  internal boolean NOT NULL DEFAULT false,
  author_user_id uuid NOT NULL,
  -- How the author reached the plan when writing: the section's teacher, the subject's coordinator,
  -- or school leadership.
  author_access text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_remedial_plan_notes_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plan_notes_plan FOREIGN KEY (plan_id, school_id)
    REFERENCES app.remedial_plans (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_remedial_plan_notes_author FOREIGN KEY (author_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_remedial_plan_notes_kind CHECK (
    (kind = 'note' AND body IS NOT NULL AND new_status IS NULL)
    OR (kind = 'status_change' AND new_status IN ('open', 'in_progress', 'achieved', 'closed'))
  ),
  CONSTRAINT ck_remedial_plan_notes_body
    CHECK (body IS NULL OR (btrim(body) <> '' AND char_length(body) <= 2000)),
  CONSTRAINT ck_remedial_plan_notes_author_access
    CHECK (author_access IN ('teacher', 'coordinator', 'leadership'))
);

-- A plan's timeline in order (and the tenant path, school_id first).
CREATE INDEX idx_remedial_plan_notes_school_plan
  ON app.remedial_plan_notes (school_id, plan_id, created_at);
CREATE INDEX idx_remedial_plan_notes_plan_fk ON app.remedial_plan_notes (plan_id, school_id);
CREATE INDEX idx_remedial_plan_notes_author_fk
  ON app.remedial_plan_notes (author_user_id, school_id);

COMMENT ON TABLE app.remedial_plan_notes IS
  'A remedial plan''s timeline: progress and follow-up notes and status changes, append-only (000269).';

-- ---------------------------------------------------------------------------------------------------
-- 3. Who may read and write
-- ---------------------------------------------------------------------------------------------------

-- How the current user reaches a section's subject as staff: 'leadership', 'teacher' (teaches the
-- subject there), 'coordinator' (coordinates it for the section's grade, 000261), or NULL.
CREATE FUNCTION app.remedial_plan_staff_access(target_section_id uuid, target_subject_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN app.current_user_is_school_admin() THEN 'leadership'
    WHEN app.teaches_section_subject(target_section_id, target_subject_id) THEN 'teacher'
    WHEN app.coordinates_section_subject(target_section_id, target_subject_id) THEN 'coordinator'
  END
$function$;

-- The same for a plan by id: how the current user follows it up as staff, or NULL.
CREATE FUNCTION app.remedial_plan_access(target_plan_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.remedial_plan_staff_access(plan.section_id, plan.subject_id)
  FROM app.remedial_plans AS plan
  WHERE plan.school_id = current_setting('app.school_id')::uuid
    AND plan.id = target_plan_id
$function$;

-- Staff of the plan (above); or the student and their linked parents while the plan is shared and
-- the school lets plans be shared.
CREATE FUNCTION app.can_read_remedial_plan(
  target_section_id uuid,
  target_subject_id uuid,
  target_student_id uuid,
  target_shared boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.remedial_plan_staff_access(target_section_id, target_subject_id) IS NOT NULL
    OR (
      target_shared
      AND app.is_related_to_student(target_student_id)
      AND EXISTS (
        SELECT 1
        FROM app.school_settings AS settings
        WHERE settings.school_id = current_setting('app.school_id')::uuid
          AND settings.remedial_plans_family_visible
      )
    )
$function$;

-- A plan's reviews, outcomes and timeline entries follow the plan; an internal entry is for the
-- plan's staff only.
CREATE FUNCTION app.can_read_remedial_plan_entry(target_plan_id uuid, target_internal boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.remedial_plans AS plan
    WHERE plan.school_id = current_setting('app.school_id')::uuid
      AND plan.id = target_plan_id
      AND CASE
        WHEN app.remedial_plan_staff_access(plan.section_id, plan.subject_id) IS NOT NULL THEN true
        WHEN target_internal THEN false
        ELSE app.can_read_remedial_plan(
          plan.section_id, plan.subject_id, plan.student_id, plan.shared_with_family
        )
      END
  )
$function$;

-- The subject's name for a plan the caller may read. A family reading a shared plan may not otherwise
-- see the subject (app.can_read_subject follows marks, not plans); this keeps that function as it is.
CREATE FUNCTION app.remedial_plan_subject_name(target_plan_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT subject.name
  FROM app.remedial_plans AS plan
  JOIN app.subjects AS subject
    ON subject.id = plan.subject_id AND subject.school_id = plan.school_id
  WHERE plan.school_id = current_setting('app.school_id')::uuid
    AND plan.id = target_plan_id
    AND app.can_read_remedial_plan(
      plan.section_id, plan.subject_id, plan.student_id, plan.shared_with_family
    )
$function$;

ALTER FUNCTION app.remedial_plan_staff_access(uuid, uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.remedial_plan_access(uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.can_read_remedial_plan(uuid, uuid, uuid, boolean) OWNER TO studafy_admin;
ALTER FUNCTION app.can_read_remedial_plan_entry(uuid, boolean) OWNER TO studafy_admin;
ALTER FUNCTION app.remedial_plan_subject_name(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION
  app.remedial_plan_staff_access(uuid, uuid),
  app.remedial_plan_access(uuid),
  app.can_read_remedial_plan(uuid, uuid, uuid, boolean),
  app.can_read_remedial_plan_entry(uuid, boolean),
  app.remedial_plan_subject_name(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.remedial_plan_staff_access(uuid, uuid),
  app.remedial_plan_access(uuid),
  app.can_read_remedial_plan(uuid, uuid, uuid, boolean),
  app.can_read_remedial_plan_entry(uuid, boolean),
  app.remedial_plan_subject_name(uuid)
TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

-- 000002's default privileges grant studafy_app full DML on new tables, so revoke from it as well as
-- PUBLIC before granting exactly what each table needs. Plans are never deleted (closed instead); the
-- timeline is append-only; review dates are replaced when the plan is edited and completed by a
-- follow-up note.
REVOKE ALL PRIVILEGES ON TABLE
  app.remedial_plans, app.remedial_plan_reviews, app.remedial_plan_outcomes, app.remedial_plan_notes
FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.remedial_plans TO studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.remedial_plan_reviews TO studafy_app;
GRANT SELECT, INSERT, DELETE ON TABLE app.remedial_plan_outcomes TO studafy_app;
GRANT SELECT, INSERT ON TABLE app.remedial_plan_notes TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'remedial_plans');
SELECT app.apply_tenant_isolation('app', 'remedial_plan_reviews');
SELECT app.apply_tenant_isolation('app', 'remedial_plan_outcomes');
SELECT app.apply_tenant_isolation('app', 'remedial_plan_notes');

CREATE POLICY role_scope_visibility ON app.remedial_plans
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_remedial_plan(section_id, subject_id, student_id, shared_with_family));

-- Only the section's teachers of the subject and leadership open and change a plan (and its review
-- dates and outcomes); a coordinator follows it up through the timeline.
CREATE POLICY remedial_plans_insert_scope ON app.remedial_plans
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (app.remedial_plan_staff_access(section_id, subject_id) IN ('leadership', 'teacher'));
CREATE POLICY remedial_plans_update_scope ON app.remedial_plans
  AS RESTRICTIVE FOR UPDATE TO studafy_app
  USING (app.remedial_plan_staff_access(section_id, subject_id) IN ('leadership', 'teacher'))
  WITH CHECK (app.remedial_plan_staff_access(section_id, subject_id) IN ('leadership', 'teacher'));

CREATE POLICY role_scope_visibility ON app.remedial_plan_reviews
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_remedial_plan_entry(plan_id, false));
CREATE POLICY remedial_plan_reviews_insert_scope ON app.remedial_plan_reviews
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (app.remedial_plan_access(plan_id) IN ('leadership', 'teacher'));
CREATE POLICY remedial_plan_reviews_delete_scope ON app.remedial_plan_reviews
  AS RESTRICTIVE FOR DELETE TO studafy_app
  USING (app.remedial_plan_access(plan_id) IN ('leadership', 'teacher'));
-- Completing a review: anyone who follows the plan up, coordinators included.
CREATE POLICY remedial_plan_reviews_update_scope ON app.remedial_plan_reviews
  AS RESTRICTIVE FOR UPDATE TO studafy_app
  USING (app.remedial_plan_access(plan_id) IS NOT NULL)
  WITH CHECK (app.remedial_plan_access(plan_id) IS NOT NULL);

CREATE POLICY role_scope_visibility ON app.remedial_plan_outcomes
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_remedial_plan_entry(plan_id, false));
CREATE POLICY remedial_plan_outcomes_insert_scope ON app.remedial_plan_outcomes
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (app.remedial_plan_access(plan_id) IN ('leadership', 'teacher'));
CREATE POLICY remedial_plan_outcomes_delete_scope ON app.remedial_plan_outcomes
  AS RESTRICTIVE FOR DELETE TO studafy_app
  USING (app.remedial_plan_access(plan_id) IN ('leadership', 'teacher'));

CREATE POLICY role_scope_visibility ON app.remedial_plan_notes
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_remedial_plan_entry(plan_id, internal));
CREATE POLICY remedial_plan_notes_insert_scope ON app.remedial_plan_notes
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (app.remedial_plan_access(plan_id) IS NOT NULL);

RESET ROLE;
