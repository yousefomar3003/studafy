-- Creates app.ai_conversations, app.ai_messages, and app.ai_usage_meters: the school-owned store for
-- AI chat sessions, per-message question/answer records with token accounting and chunk citations,
-- and per-student-per-billing-cycle usage meters.
--
-- Depends on 000016 (app.ai_subscriptions), 000020 (uq_ai_subscriptions_id_school), 000008
-- (app.students), and 000006 (app.apply_tenant_isolation).
--
-- ai_conversations: one row per chat session, scoped to a student within a school.
-- ai_messages: one row per message, containing question, answer, cited material chunk IDs, token
--   counts, and an expires_at marker for 90-day retention. The cleanup function
--   app.delete_expired_ai_messages() deletes rows past that marker.
-- ai_usage_meters: one row per student per billing cycle (ai_subscriptions), with an atomic upsert
--   function app.upsert_ai_usage_tokens() safe under concurrent increments.
--
-- Normalization: messages reference conversations via composite FK (conversation_id, school_id),
-- usage meters reference both students and ai_subscriptions via composite FKs. No denormalized
-- copies of student or material data. cited_chunk_ids is a uuid[] (not a FK array) because chunks
-- are deleted via CASCADE when materials are removed, and orphaning a citation is acceptable.
--
-- No updated_at on ai_messages: messages are append-only, never mutated after creation (same
-- rationale as audit_logs in 000018).
--
-- Acceptance tests are in packages/db/tests/ai-conversations.test.ts, not inline, because the
-- FK chains (countries -> currencies -> schools -> users -> students -> subscriptions) are too
-- deep for a migration-embedded DO block.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_conversations (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_conversations PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_ai_conversations_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_ai_conversations_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_conversations_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_ai_conversations_model CHECK (model = btrim(model) AND model <> ''),
  CONSTRAINT ck_ai_conversations_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.ai_messages (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_messages PRIMARY KEY,
  school_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  question text NOT NULL,
  answer text NOT NULL,
  cited_chunk_ids uuid[] NOT NULL DEFAULT '{}',
  prompt_tokens integer NOT NULL,
  completion_tokens integer NOT NULL,
  total_tokens integer NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_ai_messages_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_ai_messages_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_messages_conversation FOREIGN KEY (conversation_id, school_id)
    REFERENCES app.ai_conversations (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_ai_messages_question CHECK (question = btrim(question) AND question <> ''),
  CONSTRAINT ck_ai_messages_answer CHECK (answer = btrim(answer) AND answer <> ''),
  CONSTRAINT ck_ai_messages_prompt_tokens CHECK (prompt_tokens > 0),
  CONSTRAINT ck_ai_messages_completion_tokens CHECK (completion_tokens >= 0),
  CONSTRAINT ck_ai_messages_total_tokens CHECK (total_tokens = prompt_tokens + completion_tokens),
  CONSTRAINT ck_ai_messages_cited_chunk_ids CHECK (cited_chunk_ids IS NOT NULL),
  CONSTRAINT ck_ai_messages_expires_at CHECK (expires_at > created_at)
);

CREATE TABLE app.ai_usage_meters (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_usage_meters PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  ai_subscription_id uuid NOT NULL,
  total_tokens bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_ai_usage_meters_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_ai_usage_meters_student_subscription
    UNIQUE (school_id, student_id, ai_subscription_id),

  CONSTRAINT fk_ai_usage_meters_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_usage_meters_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_usage_meters_ai_subscription FOREIGN KEY (ai_subscription_id, school_id)
    REFERENCES app.ai_subscriptions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_ai_usage_meters_total_tokens CHECK (total_tokens >= 0),
  CONSTRAINT ck_ai_usage_meters_timestamps CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------------------------------

-- List a student's conversations newest-first. school_id leads for RLS predicate pushdown.
CREATE INDEX idx_ai_conversations_school_student_created_at
  ON app.ai_conversations (school_id, student_id, created_at DESC, id DESC);

-- List messages in a conversation in order.
CREATE INDEX idx_ai_messages_school_conversation_created_at
  ON app.ai_messages (school_id, conversation_id, created_at, id);

-- The retention cleanup function's primary access path. school_id leads for RLS, then
-- expires_at to locate expired rows efficiently.
CREATE INDEX idx_ai_messages_school_expires_at
  ON app.ai_messages (school_id, expires_at);

-- uq_ai_usage_meters_student_subscription already maintains (school_id, student_id,
-- ai_subscription_id) with school_id leading, covering the expected query: "get usage for this
-- student in this cycle." No further index is added.

-- ---------------------------------------------------------------------------------------------------
-- 3. Functions
-- ---------------------------------------------------------------------------------------------------

-- Atomic usage increment. INSERT ... ON CONFLICT DO UPDATE adds to the running total under
-- row-level locking, safe for concurrent increments from multiple API workers.
CREATE FUNCTION app.upsert_ai_usage_tokens(
  p_student_id uuid,
  p_ai_subscription_id uuid,
  p_tokens bigint
) RETURNS bigint
  LANGUAGE sql
  SET search_path = pg_catalog
  AS $$
  INSERT INTO app.ai_usage_meters (school_id, student_id, ai_subscription_id, total_tokens)
  VALUES (
    current_setting('app.school_id')::uuid,
    p_student_id,
    p_ai_subscription_id,
    p_tokens
  )
  ON CONFLICT (school_id, student_id, ai_subscription_id)
  DO UPDATE SET
    total_tokens = app.ai_usage_meters.total_tokens + EXCLUDED.total_tokens,
    updated_at = CURRENT_TIMESTAMP
  RETURNING total_tokens;
$$;

-- Batch retention cleanup. Deletes messages past their expires_at marker. Returns the number of
-- rows deleted so the caller can loop until zero. Batch size defaults to 1000 to avoid long
-- transactions.
CREATE FUNCTION app.delete_expired_ai_messages(p_batch_size integer DEFAULT 1000)
RETURNS integer
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_batch_size < 1 THEN
    RAISE EXCEPTION 'p_batch_size must be >= 1, got %', p_batch_size;
  END IF;

  WITH doomed AS (
    SELECT id, school_id
    FROM app.ai_messages
    WHERE expires_at < now()
    ORDER BY expires_at
    LIMIT p_batch_size
  )
  DELETE FROM app.ai_messages m
  USING doomed d
  WHERE m.id = d.id AND m.school_id = d.school_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.ai_conversations, app.ai_messages, app.ai_usage_meters FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.ai_conversations, app.ai_messages, app.ai_usage_meters TO studafy_app;

REVOKE ALL ON FUNCTION app.upsert_ai_usage_tokens(uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.upsert_ai_usage_tokens(uuid, uuid, bigint) TO studafy_app;

REVOKE ALL ON FUNCTION app.delete_expired_ai_messages(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_ai_messages(integer) TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'ai_conversations');
SELECT app.apply_tenant_isolation('app', 'ai_messages');
SELECT app.apply_tenant_isolation('app', 'ai_usage_meters');

RESET ROLE;
