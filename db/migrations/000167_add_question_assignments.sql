-- Question assignments: a teacher-authored set of multiple-choice and true/false questions that a
-- student answers in the app and that is marked automatically, alongside the existing written
-- assignment (free text and file attachments, marked by hand).
--
-- Creates app.assignment_kind (on app.assignments.kind), app.assignment_question_type, and three
-- tables: app.assignment_questions, app.assignment_question_options, and app.submission_answers.
--
-- Depends on 000011 (app.assignments, app.assignment_submissions), 000049
-- (app.can_read_assignment), and 000050 (app.can_read_submission).
--
-- WHY A KIND ON THE ASSIGNMENT RATHER THAN A SEPARATE QUIZ ENTITY.
-- A question assignment has everything a written one has -- a class, a deadline, a late policy, a
-- per-student submission, a mark the teacher releases. Reusing app.assignments and
-- app.assignment_submissions keeps one gradebook path, one hand-in window, and one grade-release
-- rule (grade_status, 000050) instead of a parallel copy of each. The kind only decides what a
-- hand-in consists of. The AI-generated app.quizzes (000099) are a different thing entirely: owned
-- by one student, generated, never set by a teacher.
--
-- WHY THE ANSWER KEY IS A COLUMN ON THE OPTION.
-- is_correct sits on the option row, with uq_assignment_question_options_one_correct allowing at
-- most one true per question. The alternative, correct_option_id on the question, makes the two
-- tables reference each other and needs a deferrable constraint to insert either first. "Exactly
-- one" (rather than "at most one") is enforced by the API, which replaces a question set in one
-- transaction and validates it before writing.
--
-- WHY THE KEY IS NOT HIDDEN BY A ROW POLICY.
-- A student must read the options to answer them; only one column of the row is secret, and only
-- until their mark is released. That is a column rule, and a row policy cannot express it -- the
-- same reasoning 000050 gives for an unreleased score. The API withholds is_correct at the response
-- projection (apps/api/src/modules/academics/assignments/routes/assignment-routes.ts).
--
-- WHY NO SCORE IS STORED FOR AN AUTOMATICALLY MARKED ANSWER.
-- The mark is derived: the sum of points for the questions whose chosen option is correct. Storing
-- it would be a second copy that could disagree with the answers, and storing it on the submission
-- would have to go through ck_assignment_submissions_lifecycle, which (rightly) requires a human
-- grader before any score exists. The API computes it on read and the teacher publishes it through
-- the existing grading path, which is also what keeps it hidden from the student until then.

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Assignment kind
-- ---------------------------------------------------------------------------------------------------

CREATE TYPE app.assignment_kind AS ENUM ('written', 'questions');

REVOKE ALL ON TYPE app.assignment_kind FROM PUBLIC;
GRANT USAGE ON TYPE app.assignment_kind TO studafy_app;

-- A constant default: every existing assignment is a written one, so no backfill is needed (and
-- none would be expressible here -- see 000050's header on cross-tenant UPDATEs in a migration).
ALTER TABLE app.assignments
  ADD COLUMN kind app.assignment_kind NOT NULL DEFAULT 'written';

-- ---------------------------------------------------------------------------------------------------
-- 2. Questions
-- ---------------------------------------------------------------------------------------------------

CREATE TYPE app.assignment_question_type AS ENUM ('multiple_choice', 'true_false');

REVOKE ALL ON TYPE app.assignment_question_type FROM PUBLIC;
GRANT USAGE ON TYPE app.assignment_question_type TO studafy_app;

CREATE TABLE app.assignment_questions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_assignment_questions PRIMARY KEY,
  school_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  -- 1-based display order. Unique per assignment so two questions cannot claim the same slot.
  position integer NOT NULL,
  question_type app.assignment_question_type NOT NULL,
  prompt text NOT NULL,
  -- Same precision as app.assignments.max_score, which the API keeps equal to the sum of these.
  points numeric(10, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_assignment_questions_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_assignment_questions_assignment_position UNIQUE (school_id, assignment_id, position),
  CONSTRAINT fk_assignment_questions_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- CASCADE for the reason 000049 gives for attachments: a question has no meaning apart from its
  -- assignment. Deleting an assignment that has submissions is already impossible (submissions
  -- reference it ON DELETE RESTRICT, and deleteAssignment archives instead), so this cannot take
  -- answered questions with it.
  CONSTRAINT fk_assignment_questions_assignment FOREIGN KEY (assignment_id, school_id)
    REFERENCES app.assignments (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_assignment_questions_position CHECK (position >= 1),
  CONSTRAINT ck_assignment_questions_prompt CHECK (prompt = btrim(prompt) AND prompt <> ''),
  CONSTRAINT ck_assignment_questions_points CHECK (points > 0),
  CONSTRAINT ck_assignment_questions_timestamps CHECK (updated_at >= created_at)
);

-- uq_assignment_questions_assignment_position already serves (school_id, assignment_id) lookups as
-- a btree prefix, ordered by position -- exactly the order every read wants -- so no further index.

REVOKE ALL PRIVILEGES ON TABLE app.assignment_questions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.assignment_questions TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'assignment_questions');

-- As visible as the assignment it belongs to: the same predicate 000049 put on attachments.
CREATE POLICY role_scope_visibility ON app.assignment_questions
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_assignment(assignment_id));

-- ---------------------------------------------------------------------------------------------------
-- 3. Options
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.assignment_question_options (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_assignment_question_options PRIMARY KEY,
  school_id uuid NOT NULL,
  question_id uuid NOT NULL,
  position integer NOT NULL,
  text text NOT NULL,
  is_correct boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_assignment_question_options_id_school UNIQUE (id, school_id),
  -- Target of fk_submission_answers_option below: it lets an answer's (option, question) pair be
  -- checked by the database, so an answer can never name an option from a different question.
  CONSTRAINT uq_assignment_question_options_id_question_school UNIQUE (id, question_id, school_id),
  CONSTRAINT uq_assignment_question_options_question_position
    UNIQUE (school_id, question_id, position),
  CONSTRAINT fk_assignment_question_options_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assignment_question_options_question FOREIGN KEY (question_id, school_id)
    REFERENCES app.assignment_questions (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_assignment_question_options_position CHECK (position >= 1),
  CONSTRAINT ck_assignment_question_options_text CHECK (text = btrim(text) AND text <> '')
);

-- At most one correct option per question. See the header for why "exactly one" lives in the API.
CREATE UNIQUE INDEX uq_assignment_question_options_one_correct
  ON app.assignment_question_options (school_id, question_id)
  WHERE is_correct;

REVOKE ALL PRIVILEGES ON TABLE app.assignment_question_options FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.assignment_question_options TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'assignment_question_options');

-- Resolves an option's question to its assignment and defers to app.can_read_assignment, so an
-- option is exactly as visible as the assignment. SECURITY DEFINER for the reason 000037 gives: it
-- is called from a RESTRICTIVE policy and reads app.assignment_questions, which carries its own
-- restrictive policy -- an invoker lookup would re-enter it. Pinned to the app.school_id GUC, so
-- still school-scoped.
CREATE FUNCTION app.can_read_assignment_question(target_question_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.assignment_questions AS q
    WHERE q.id = target_question_id
      AND q.school_id = current_setting('app.school_id')::uuid
      AND app.can_read_assignment(q.assignment_id)
  )
$function$;

REVOKE ALL ON FUNCTION app.can_read_assignment_question(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_assignment_question(uuid) TO studafy_app;

CREATE POLICY role_scope_visibility ON app.assignment_question_options
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_assignment_question(question_id));

-- ---------------------------------------------------------------------------------------------------
-- 4. Answers
-- ---------------------------------------------------------------------------------------------------

-- One row per question the student answered on their current attempt. Resubmission replaces the
-- set (the submission row itself is updated in place, 000050), so there is no attempt_number here:
-- only the answers being marked exist.
CREATE TABLE app.submission_answers (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_submission_answers PRIMARY KEY,
  school_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  question_id uuid NOT NULL,
  option_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_submission_answers_id_school UNIQUE (id, school_id),
  -- One answer per question per submission. Also serves every read, which leads with
  -- (school_id, submission_id).
  CONSTRAINT uq_submission_answers_submission_question
    UNIQUE (school_id, submission_id, question_id),
  CONSTRAINT fk_submission_answers_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- CASCADE: an answer is part of the submission, like an attachment (000050).
  CONSTRAINT fk_submission_answers_submission FOREIGN KEY (submission_id, school_id)
    REFERENCES app.assignment_submissions (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  -- RESTRICT, so a question or option that has been answered cannot be deleted out from under the
  -- student's work. The API refuses to replace an answered question set before it gets here.
  CONSTRAINT fk_submission_answers_question FOREIGN KEY (question_id, school_id)
    REFERENCES app.assignment_questions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The option must belong to the answered question: a composite key over (option, question), so
  -- the pairing is a database fact rather than something only the API checks.
  CONSTRAINT fk_submission_answers_option FOREIGN KEY (option_id, question_id, school_id)
    REFERENCES app.assignment_question_options (id, question_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Serves the RESTRICT checks on the two referenced tables, which would otherwise scan this table on
-- every question or option delete.
CREATE INDEX idx_submission_answers_school_question
  ON app.submission_answers (school_id, question_id);
CREATE INDEX idx_submission_answers_school_option
  ON app.submission_answers (school_id, option_id);

REVOKE ALL PRIVILEGES ON TABLE app.submission_answers FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.submission_answers TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'submission_answers');

-- Exactly as visible as the submission: the student, a linked parent, the class's teacher, or an
-- admin. The same predicate 000050 put on submission attachments.
CREATE POLICY role_scope_visibility ON app.submission_answers
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_submission(submission_id));

RESET ROLE;
