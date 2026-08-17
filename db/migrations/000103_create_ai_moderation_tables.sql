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
  school_id      uuid        NOT NULL,
  student_id     uuid        NOT NULL,
  message_id     uuid,
  phase          text        NOT NULL CHECK (phase IN ('input', 'output')),
  text_hash      text        NOT NULL,
  blocked        boolean     NOT NULL,
  category       text        CHECK (category IN (
    'profanity', 'hate_speech', 'self_harm', 'sexual_content', 'violence', 'pii_sharing'
  )),
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, school_id),

  CONSTRAINT fk_ai_moderation_decisions_school
    FOREIGN KEY (school_id) REFERENCES app.schools(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_moderation_decisions_student
    FOREIGN KEY (student_id, school_id) REFERENCES app.students(id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_moderation_decisions_message
    FOREIGN KEY (message_id, school_id) REFERENCES app.ai_messages(id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_ai_moderation_decisions_school_student_created
  ON app.ai_moderation_decisions (school_id, student_id, created_at DESC, id DESC);

CREATE INDEX idx_ai_moderation_decisions_school_message
  ON app.ai_moderation_decisions (school_id, message_id)
  WHERE message_id IS NOT NULL;

CREATE TABLE app.ai_answer_reports (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid        NOT NULL,
  student_id     uuid        NOT NULL,
  message_id     uuid        NOT NULL,
  reporter_id    uuid        NOT NULL,
  reason         text        NOT NULL CHECK (length(trim(reason)) > 0),
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, message_id, reporter_id),
  UNIQUE (id, school_id),

  CONSTRAINT fk_ai_answer_reports_school
    FOREIGN KEY (school_id) REFERENCES app.schools(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_answer_reports_student
    FOREIGN KEY (student_id, school_id) REFERENCES app.students(id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_answer_reports_message
    FOREIGN KEY (message_id, school_id) REFERENCES app.ai_messages(id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_answer_reports_reporter
    FOREIGN KEY (reporter_id, school_id) REFERENCES app.students(id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_answer_reports_reviewed_by
    FOREIGN KEY (reviewed_by, school_id) REFERENCES app.users(id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_ai_answer_reports_school_status_created
  ON app.ai_answer_reports (school_id, status, created_at DESC, id DESC);

CREATE INDEX idx_ai_answer_reports_school_message
  ON app.ai_answer_reports (school_id, message_id);

-- ---------------------------------------------------------------------------------------------------
-- 2. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE
  app.ai_moderation_decisions, app.ai_answer_reports
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.ai_moderation_decisions, app.ai_answer_reports
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'ai_moderation_decisions');
SELECT app.apply_tenant_isolation('app', 'ai_answer_reports');

RESET ROLE;
