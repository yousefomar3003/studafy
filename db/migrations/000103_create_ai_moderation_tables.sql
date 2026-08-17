-- Creates app.ai_moderation_decisions and app.ai_answer_reports: the content moderation audit
-- trail and teacher-visible answer flagging surface for Ask AI.
--
-- ai_moderation_decisions: one row per moderation check (input or output), recording whether the
-- check blocked or allowed the text, the matched category (if blocked), and a sha256 hash of the
-- checked text for dedup/lookup without duplicating the full text (which already lives in
-- app.ai_messages.question or app.ai_messages.answer). This is the audit trail the acceptance
-- criteria require -- every moderation decision is persisted, whether it blocked or allowed.
--
-- ai_answer_reports: one row per student report of an AI answer. A student can report an answer
-- that passed auto-moderation but they believe is inappropriate or incorrect. Teachers review
-- reported answers; the status column tracks the review lifecycle (pending -> reviewed/dismissed).
-- Unique on (message_id, reporter_id) to prevent double-reports.
--
-- Depends on 000008 (app.students), 000021 (app.ai_messages), and 000006
-- (app.apply_tenant_isolation).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_moderation_decisions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid        NOT NULL REFERENCES app.schools(id),
  student_id     uuid        NOT NULL REFERENCES app.students(id, school_id),
  message_id     uuid        REFERENCES app.ai_messages(id, school_id),
  phase          text        NOT NULL CHECK (phase IN ('input', 'output')),
  text_hash      text        NOT NULL,
  blocked        boolean     NOT NULL,
  category       text        CHECK (category IN (
    'profanity', 'hate_speech', 'self_harm', 'sexual_content', 'violence', 'pii_sharing'
  )),
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, school_id)
);

CREATE INDEX idx_ai_moderation_decisions_school_student_created
  ON app.ai_moderation_decisions (school_id, student_id, created_at DESC, id DESC);

CREATE INDEX idx_ai_moderation_decisions_school_message
  ON app.ai_moderation_decisions (school_id, message_id)
  WHERE message_id IS NOT NULL;

CREATE TABLE app.ai_answer_reports (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid        NOT NULL REFERENCES app.schools(id),
  student_id     uuid        NOT NULL REFERENCES app.students(id, school_id),
  message_id     uuid        NOT NULL REFERENCES app.ai_messages(id, school_id),
  reporter_id    uuid        NOT NULL REFERENCES app.students(id, school_id),
  reason         text        NOT NULL CHECK (length(trim(reason)) > 0),
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  reviewed_by    uuid        REFERENCES app.users(id),
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, message_id, reporter_id),
  UNIQUE (id, school_id)
);

CREATE INDEX idx_ai_answer_reports_school_status_created
  ON app.ai_answer_reports (school_id, status, created_at DESC, id DESC);

CREATE INDEX idx_ai_answer_reports_school_message
  ON app.ai_answer_reports (school_id, message_id);

-- ---------------------------------------------------------------------------------------------------
-- 2. RLS policies
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.ai_moderation_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_moderation_decisions_isolation ON app.ai_moderation_decisions
  USING (school_id = current_setting('app.school_id', true)::uuid);

ALTER TABLE app.ai_answer_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_answer_reports_isolation ON app.ai_answer_reports
  USING (school_id = current_setting('app.school_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON app.ai_moderation_decisions TO studafy_app;
GRANT SELECT, INSERT, UPDATE ON app.ai_answer_reports TO studafy_app;

RESET ROLE;
