-- Creates app.quizzes, app.quiz_questions, and app.quiz_question_options: the school-owned store for
-- AI-generated quizzes (ST-167), grounded on ingested material chunks with a per-question citation
-- and answer key.
--
-- Depends on 000008 (app.students), 000019 (app.material_chunks), and 000006
-- (app.apply_tenant_isolation).
--
-- quizzes: one row per generated quiz, scoped to a student within a school. Append-only, like
-- ai_messages (000021) -- a quiz is never edited after generation, only graded against.
-- quiz_questions: one row per question, carrying the prompt, the short-answer key or an MCQ's
-- correct_option_id, and a citation to the single material chunk the question was grounded on.
-- quiz_question_options: one row per MCQ choice. Normalized rather than a jsonb array -- a fixed,
-- small, wholly-internal shape (a label and its text) is exactly what this schema's normalization
-- convention (material_chunks, ai_message_citations) puts in its own rows, not a flexible column;
-- see db/policies/rls-coverage.ts's approved_flexible_columns for the narrower carve-out this
-- deliberately does not use.
--
-- Normalization: a question's citation is its material_chunk_id, nothing denormalized alongside it
-- (no material title, no page number copied here) -- exactly the ai_message_citations precedent
-- (000023). Rendering a citation joins back to app.material_chunks / app.materials at read time.
--
-- The answer key never leaves this table until a grading request asks for it: the generation route
-- returns each question's prompt, options, and citation, but never correct_option_id or
-- correct_answer -- see apps/api/src/modules/ai/routes/quiz-routes.ts and
-- docs/rag/quiz-generation-and-grading.md.
--
-- No updated_at on any of the three tables: all are append-only, never mutated after creation (same
-- rationale as audit_logs in 000018 and ai_messages in 000021).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.quizzes (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_quizzes PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  model text NOT NULL,
  question_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_quizzes_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_quizzes_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_quizzes_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_quizzes_model CHECK (model = btrim(model) AND model <> ''),
  CONSTRAINT ck_quizzes_question_count CHECK (question_count >= 1)
);

-- One question: one MCQ or short-answer item, with its citation and (hidden from the generation
-- response) answer key. question_order is the question's 1-based position within its quiz -- a
-- structural column, like material_chunks.chunk_index, not a repeating group: it is what makes a
-- quiz's question sequence reconstructible in the order the model produced it, and what a grading
-- request's question ids are resolved against.
--
-- correct_option_id / correct_answer are mutually exclusive by question_type, enforced by
-- ck_quiz_questions_shape below: an MCQ row always has a correct_option_id, never a correct_answer;
-- a short_answer row always has a correct_answer, never a correct_option_id. This is the
-- database-level half of "questions validate against schema, no malformed options" -- the
-- application-level half is the Zod schema (apps/api/src/modules/ai/quiz/schema.ts) the model's JSON
-- output is validated against before this insert ever runs. There is no FK enforcing that an MCQ's
-- correct_option_id names a real row in quiz_question_options below: that would require the row to
-- exist before the option it names does (both tables would need to reference the other), and
-- PostgreSQL CHECK constraints cannot contain subqueries either. That invariant -- like option-key
-- and option-text uniqueness before normalization moved those two into quiz_question_options's own
-- UNIQUE constraint -- is enforced only at the application layer.
CREATE TABLE app.quiz_questions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_quiz_questions PRIMARY KEY,
  school_id uuid NOT NULL,
  quiz_id uuid NOT NULL,
  question_order integer NOT NULL,
  question_type text NOT NULL,
  prompt text NOT NULL,
  correct_option_id text,
  correct_answer text,
  material_chunk_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_quiz_questions_id_school UNIQUE (id, school_id),
  -- The real business key: a quiz has exactly one question at each ordinal. Also the relational
  -- lookup index for "load this quiz's questions in order" -- school_id leading -- so no separate
  -- CREATE INDEX is issued for it, the same reasoning as uq_material_chunks_material_chunk (000019).
  CONSTRAINT uq_quiz_questions_quiz_order UNIQUE (school_id, quiz_id, question_order),

  CONSTRAINT fk_quiz_questions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_quiz_questions_quiz FOREIGN KEY (quiz_id, school_id)
    REFERENCES app.quizzes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- CASCADE, not RESTRICT: this is the ai_message_citations precedent (000023), not the
  -- fk_quiz_questions_quiz one above. A citation is meaningless once its chunk is gone, and RESTRICT
  -- here would make a material undeletable for as long as any quiz ever cited it.
  CONSTRAINT fk_quiz_questions_chunk FOREIGN KEY (material_chunk_id, school_id)
    REFERENCES app.material_chunks (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,

  CONSTRAINT ck_quiz_questions_order CHECK (question_order >= 1),
  CONSTRAINT ck_quiz_questions_type CHECK (question_type IN ('mcq', 'short_answer')),
  CONSTRAINT ck_quiz_questions_prompt CHECK (prompt = btrim(prompt) AND prompt <> ''),
  CONSTRAINT ck_quiz_questions_shape CHECK (
    (
      question_type = 'mcq'
      AND correct_option_id IS NOT NULL
      AND correct_option_id = btrim(correct_option_id) AND correct_option_id <> ''
      AND correct_answer IS NULL
    )
    OR
    (
      question_type = 'short_answer'
      AND correct_option_id IS NULL
      AND correct_answer IS NOT NULL
      AND correct_answer = btrim(correct_answer) AND correct_answer <> ''
    )
  )
);

-- One MCQ choice. Exists only for question_type = 'mcq' rows (nothing enforces that here beyond the
-- application, the same posture the routing table takes elsewhere: a short_answer question simply
-- never gets rows inserted for it).
CREATE TABLE app.quiz_question_options (
  school_id uuid NOT NULL,
  quiz_question_id uuid NOT NULL,
  -- 1-based position among the question's options, in generation order -- the rendering order, not
  -- a business key on its own (option_key is that).
  option_order integer NOT NULL,
  option_key text NOT NULL,
  option_text text NOT NULL,

  CONSTRAINT pk_quiz_question_options PRIMARY KEY (school_id, quiz_question_id, option_order),
  -- Database-level half of "no malformed options": a question cannot carry two options with the
  -- same key. (Option-text uniqueness and the 2-6 cardinality bound remain application-level only,
  -- the same class of invariant a CHECK constraint cannot express without a subquery.)
  CONSTRAINT uq_quiz_question_options_key UNIQUE (school_id, quiz_question_id, option_key),

  CONSTRAINT fk_quiz_question_options_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- CASCADE: an option has no independent existence or meaning once its question is gone -- the
  -- same rationale material_chunks (000019) gives for cascading from materials.
  CONSTRAINT fk_quiz_question_options_question FOREIGN KEY (quiz_question_id, school_id)
    REFERENCES app.quiz_questions (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,

  CONSTRAINT ck_quiz_question_options_order CHECK (option_order >= 1),
  CONSTRAINT ck_quiz_question_options_key CHECK (option_key = btrim(option_key) AND option_key <> ''),
  CONSTRAINT ck_quiz_question_options_text CHECK (option_text = btrim(option_text) AND option_text <> '')
);

-- ---------------------------------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------------------------------

-- List a student's quizzes newest-first. school_id leads for RLS predicate pushdown -- the same
-- shape ai_conversations (000021) uses.
CREATE INDEX idx_quizzes_school_student_created_at
  ON app.quizzes (school_id, student_id, created_at DESC, id DESC);

-- uq_quiz_questions_quiz_order and pk_quiz_question_options already maintain a school_id-leading
-- btree over their tables' access paths (see the comments beside each). No further index is added.

-- ---------------------------------------------------------------------------------------------------
-- 3. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.quizzes, app.quiz_questions, app.quiz_question_options FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.quizzes, app.quiz_questions, app.quiz_question_options
  TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'quizzes');
SELECT app.apply_tenant_isolation('app', 'quiz_questions');
SELECT app.apply_tenant_isolation('app', 'quiz_question_options');

RESET ROLE;
