-- Creates app.exam_sessions, app.exam_items, app.exam_item_options, and app.exam_item_answers: the
-- school-owned store for AI-generated timed mock exams (ST-171), grounded on ingested material
-- chunks with a per-item citation and answer key -- the exam-mode counterpart to
-- app.quizzes/app.quiz_questions/app.quiz_question_options (000099), whose shape this deliberately
-- mirrors.
--
-- Depends on 000008 (app.students), 000019 (app.material_chunks), and 000006
-- (app.apply_tenant_isolation).
--
-- Naming: app.exams and app.exam_results already exist (000011) as the teacher-administered,
-- scheduled academic exam record -- a different owner, different columns, different meaning
-- entirely. "exam_sessions" (not "exams") avoids that collision while keeping the AI-mode name
-- ST-171 actually asks for.
--
-- exam_sessions: one row per generation request, created with status = 'generating' *before* the
-- worker (apps/workers/src/queues/exam-generation) has produced anything, unlike app.quizzes whose
-- row is written only after a successful synchronous generation. The five-state lifecycle
-- (generating -> ready -> in_progress -> submitted, or generating -> failed) and which columns must
-- be null/non-null in each state is enforced by ck_exam_sessions_lifecycle, the same discipline
-- ck_exam_results_lifecycle (000011) and ck_assignment_submissions_lifecycle (000011) use. There is
-- deliberately no stored "expired" state: expiry is a read-time/submit-time comparison of now()
-- against expires_at on an in_progress row (the app.ai_messages.expires_at precedent, 000021), not a
-- transition -- an abandoned, never-submitted attempt simply stays in_progress, the same posture
-- assignment_submissions takes toward a draft never turned in.
--
-- exam_items / exam_item_options: identical shape and normalization rationale to
-- quiz_questions / quiz_question_options (000099) -- see that migration's comments, which apply
-- here unchanged. The answer key (correct_option_id / correct_answer) never leaves this table until
-- a submit request grades it, the same posture quiz's generation route takes; see
-- apps/api/src/modules/ai/exam/persistence.ts and docs/rag/exam-mode.md.
--
-- exam_item_answers: has no quiz counterpart -- quiz grading is a stateless, repeatable pure
-- function with nothing persisted, but an exam is a one-shot timed attempt whose report must be
-- re-fetchable later, so what the student actually submitted (and whether it was correct) is
-- written once, at submit. No report is denormalized alongside it: the per-topic report is computed
-- at read time by joining exam_items -> exam_item_answers -> material_chunks -> materials, the same
-- "join at read time, don't copy" rule the quiz migration states for citations.
--
-- No updated_at anywhere: exam_sessions is mutated in place across its lifecycle (unlike quizzes'
-- append-only row) but always through one of the four route handlers, each of which already knows
-- which timestamp column it is setting; exam_items / exam_item_options / exam_item_answers are
-- append-only, like quiz_questions / quiz_question_options.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.exam_sessions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_exam_sessions PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  -- model/tier are resolved (resolveAiModel("exam", ...)) and stored at creation, before generation
  -- runs -- unlike quizzes.model, which is only known (and only written) after a successful
  -- synchronous call.
  model text NOT NULL,
  tier text NOT NULL,
  question_count integer NOT NULL,
  duration_minutes integer NOT NULL,
  status text NOT NULL DEFAULT 'generating',
  started_at timestamptz,
  expires_at timestamptz,
  submitted_at timestamptz,
  correct_count integer,
  -- Provider-reported usage, written by the worker on a successful generation. Informational only:
  -- the quota charge for this session was already committed at creation time against the
  -- reservation ceiling (see docs/rag/exam-mode.md's "Quota" section for why), not settled from
  -- these columns.
  input_tokens integer,
  output_tokens integer,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_exam_sessions_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_exam_sessions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exam_sessions_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_exam_sessions_model CHECK (model = btrim(model) AND model <> ''),
  CONSTRAINT ck_exam_sessions_tier CHECK (tier IN ('small', 'large')),
  CONSTRAINT ck_exam_sessions_question_count CHECK (question_count >= 1),
  CONSTRAINT ck_exam_sessions_duration_minutes CHECK (duration_minutes >= 1),
  CONSTRAINT ck_exam_sessions_status CHECK (
    status IN ('generating', 'ready', 'in_progress', 'submitted', 'failed')
  ),
  CONSTRAINT ck_exam_sessions_time_range CHECK (
    started_at IS NULL OR expires_at IS NULL OR expires_at > started_at
  ),
  CONSTRAINT ck_exam_sessions_submission_time CHECK (
    submitted_at IS NULL OR (started_at IS NOT NULL AND submitted_at >= started_at)
  ),
  -- Defense in depth: the submit route already refuses a late submission (409 AI_EXAM_EXPIRED)
  -- before writing submitted_at, but the invariant is cheap to also assert at the storage layer.
  CONSTRAINT ck_exam_sessions_submission_before_expiry CHECK (
    submitted_at IS NULL OR expires_at IS NULL OR submitted_at <= expires_at
  ),
  CONSTRAINT ck_exam_sessions_failure_reason CHECK (
    failure_reason IS NULL OR (failure_reason = btrim(failure_reason) AND failure_reason <> '')
  ),
  CONSTRAINT ck_exam_sessions_lifecycle CHECK (
    (status = 'generating'
      AND started_at IS NULL AND expires_at IS NULL AND submitted_at IS NULL
      AND correct_count IS NULL AND input_tokens IS NULL AND output_tokens IS NULL
      AND failure_reason IS NULL)
    OR (status = 'ready'
      AND started_at IS NULL AND expires_at IS NULL AND submitted_at IS NULL
      AND correct_count IS NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
      AND failure_reason IS NULL)
    OR (status = 'in_progress'
      AND started_at IS NOT NULL AND expires_at IS NOT NULL AND submitted_at IS NULL
      AND correct_count IS NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
      AND failure_reason IS NULL)
    OR (status = 'submitted'
      AND started_at IS NOT NULL AND expires_at IS NOT NULL AND submitted_at IS NOT NULL
      AND correct_count IS NOT NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
      AND failure_reason IS NULL)
    OR (status = 'failed'
      AND started_at IS NULL AND expires_at IS NULL AND submitted_at IS NULL
      AND correct_count IS NULL AND input_tokens IS NULL AND output_tokens IS NULL
      AND failure_reason IS NOT NULL)
  )
);

-- One item: one MCQ or short-answer question, with its citation and (hidden from the started-exam
-- response) answer key. Shape and rationale identical to app.quiz_questions (000099); see that
-- migration for the full explanation of ck_exam_items_shape's mcq/short_answer mutual exclusion and
-- why the correct_option_id/material_chunk_id invariants it does not cover are application-level
-- only (apps/workers/src/queues/exam-generation/schema.ts).
CREATE TABLE app.exam_items (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_exam_items PRIMARY KEY,
  school_id uuid NOT NULL,
  exam_session_id uuid NOT NULL,
  item_order integer NOT NULL,
  item_type text NOT NULL,
  prompt text NOT NULL,
  correct_option_id text,
  correct_answer text,
  material_chunk_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_exam_items_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_exam_items_session_order UNIQUE (school_id, exam_session_id, item_order),

  CONSTRAINT fk_exam_items_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exam_items_session FOREIGN KEY (exam_session_id, school_id)
    REFERENCES app.exam_sessions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exam_items_chunk FOREIGN KEY (material_chunk_id, school_id)
    REFERENCES app.material_chunks (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,

  CONSTRAINT ck_exam_items_order CHECK (item_order >= 1),
  CONSTRAINT ck_exam_items_type CHECK (item_type IN ('mcq', 'short_answer')),
  CONSTRAINT ck_exam_items_prompt CHECK (prompt = btrim(prompt) AND prompt <> ''),
  CONSTRAINT ck_exam_items_shape CHECK (
    (
      item_type = 'mcq'
      AND correct_option_id IS NOT NULL
      AND correct_option_id = btrim(correct_option_id) AND correct_option_id <> ''
      AND correct_answer IS NULL
    )
    OR
    (
      item_type = 'short_answer'
      AND correct_option_id IS NULL
      AND correct_answer IS NOT NULL
      AND correct_answer = btrim(correct_answer) AND correct_answer <> ''
    )
  )
);

-- One MCQ choice. Identical shape to app.quiz_question_options (000099).
CREATE TABLE app.exam_item_options (
  school_id uuid NOT NULL,
  exam_item_id uuid NOT NULL,
  option_order integer NOT NULL,
  option_key text NOT NULL,
  option_text text NOT NULL,

  CONSTRAINT pk_exam_item_options PRIMARY KEY (school_id, exam_item_id, option_order),
  CONSTRAINT uq_exam_item_options_key UNIQUE (school_id, exam_item_id, option_key),

  CONSTRAINT fk_exam_item_options_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exam_item_options_item FOREIGN KEY (exam_item_id, school_id)
    REFERENCES app.exam_items (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,

  CONSTRAINT ck_exam_item_options_order CHECK (option_order >= 1),
  CONSTRAINT ck_exam_item_options_key CHECK (option_key = btrim(option_key) AND option_key <> ''),
  CONSTRAINT ck_exam_item_options_text CHECK (option_text = btrim(option_text) AND option_text <> '')
);

-- What the student actually submitted for one item, and whether it was correct -- written once, by
-- the submit route, never updated after. Exists because (unlike quiz grading, a stateless pure
-- function recomputed on every grade request) an exam's per-topic report must be re-fetchable after
-- the one submit call that produced it. One row per item is the natural key: an item with no row
-- here was never submitted for (should not happen once a session reaches 'submitted', since the
-- submit route writes a row -- with submitted_answer NULL -- for every item in the session).
CREATE TABLE app.exam_item_answers (
  school_id uuid NOT NULL,
  exam_item_id uuid NOT NULL,
  submitted_answer text,
  is_correct boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT pk_exam_item_answers PRIMARY KEY (school_id, exam_item_id),

  CONSTRAINT fk_exam_item_answers_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_exam_item_answers_item FOREIGN KEY (exam_item_id, school_id)
    REFERENCES app.exam_items (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,

  CONSTRAINT ck_exam_item_answers_submitted_answer CHECK (
    submitted_answer IS NULL
    OR (submitted_answer = btrim(submitted_answer) AND submitted_answer <> '')
  ),
  -- A missing answer is always graded wrong -- the same "unanswered = wrong, not skipped" rule
  -- quiz/grading.ts documents for its own pure function.
  CONSTRAINT ck_exam_item_answers_no_answer_is_wrong CHECK (
    submitted_answer IS NOT NULL OR is_correct = false
  )
);

-- ---------------------------------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------------------------------

-- List a student's exam sessions newest-first. school_id leads for RLS predicate pushdown -- the
-- same shape idx_quizzes_school_student_created_at (000099) uses.
CREATE INDEX idx_exam_sessions_school_student_created_at
  ON app.exam_sessions (school_id, student_id, created_at DESC, id DESC);

-- uq_exam_items_session_order, pk_exam_item_options, and pk_exam_item_answers already maintain a
-- school_id-leading btree over their tables' access paths (see the comments beside each). No further
-- index is added, the same reasoning 000099 gives for its own tables.

-- ---------------------------------------------------------------------------------------------------
-- 3. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE
  app.exam_sessions, app.exam_items, app.exam_item_options, app.exam_item_answers
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.exam_sessions, app.exam_items, app.exam_item_options, app.exam_item_answers
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'exam_sessions');
SELECT app.apply_tenant_isolation('app', 'exam_items');
SELECT app.apply_tenant_isolation('app', 'exam_item_options');
SELECT app.apply_tenant_isolation('app', 'exam_item_answers');

RESET ROLE;
