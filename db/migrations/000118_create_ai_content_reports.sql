-- AI content reporting and moderation queue (ST-306).
--
-- Depends on 000103 (app.ai_moderation_decisions, app.ai_answer_reports), 000008 (app.students),
-- 000007 (app.users), and 000006 (app.apply_tenant_isolation).
--
-- 1. app.ai_content_reports replaces app.ai_answer_reports. The old table could only point at an
--    Ask AI message (FK to app.ai_messages); quizzes, flashcard decks, and summaries need the same
--    Report action, and one queue is what a moderator works. A row is either a user's report
--    (`source = 'user_report'`, `reporter_id` set) or a safety-filter escalation
--    (`source = 'safety_filter'`, no reporter) -- the filter files the latter itself when it blocks
--    child-safety content, so that category always reaches a human.
--
--    A user report points at the item with `content_id` -- polymorphic (message, quiz, deck, or
--    material id), so it carries no FK. A filter escalation has no item to point at (the blocked
--    text was never persisted as a quiz, deck, or message), so it points at the moderation
--    decision that blocked it instead (`moderation_decision_id`).
--    `content_snapshot` is the reported text as the server read it at report time: the moderator
--    reviews exactly what the student saw even after the source row expires (ai_messages have an
--    expires_at) or, for summaries, never existed in Postgres at all (they live only in the Redis
--    summary cache). Plain text, never jsonb, so the RLS coverage audit's flexible-column rule
--    does not apply.
--
--    `priority` and `respond_by` are fixed at insert from the reason category (see
--    apps/api/src/modules/ai/moderation/reports.ts) so "overdue" is a plain comparison against
--    now(). The workflow is pending -> in_review -> {actioned | dismissed | escalated}, with
--    escalated -> {actioned | dismissed} once the external hand-off is done; closed rows carry who
--    closed them and when (ck_ai_content_reports_review).
--
-- 2. app.ai_moderation_decisions gains `surface` (which AI feature the checked text came from --
--    the table was Ask-only until generation-side filtering was added to quizzes, flashcards, and
--    summaries) and the `csam` category.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. app.ai_content_reports
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_content_reports (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_content_reports PRIMARY KEY,
  school_id uuid NOT NULL,
  -- The student whose AI output this is (the content owner), not necessarily the reporter.
  student_id uuid NOT NULL,
  content_type text NOT NULL,
  content_id uuid,
  moderation_decision_id uuid,
  content_snapshot text NOT NULL,
  source text NOT NULL,
  reporter_id uuid,
  reason_category text NOT NULL,
  reason text,
  priority text NOT NULL,
  respond_by timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  resolution_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_ai_content_reports_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_ai_content_reports_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_content_reports_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_content_reports_reporter FOREIGN KEY (reporter_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_content_reports_moderation_decision FOREIGN KEY (moderation_decision_id, school_id)
    REFERENCES app.ai_moderation_decisions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_content_reports_reviewed_by FOREIGN KEY (reviewed_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_ai_content_reports_content_type
    CHECK (content_type IN ('ask_question', 'ask_answer', 'quiz', 'flashcard_deck', 'summary')),
  CONSTRAINT ck_ai_content_reports_content_snapshot
    CHECK (btrim(content_snapshot) <> '' AND length(content_snapshot) <= 60000),
  CONSTRAINT ck_ai_content_reports_source
    CHECK (source IN ('user_report', 'safety_filter')),
  -- A user report names its reporter and the reported item; a filter escalation names neither and
  -- points at the blocking decision instead.
  CONSTRAINT ck_ai_content_reports_source_shape CHECK (
    (source = 'user_report' AND reporter_id IS NOT NULL AND content_id IS NOT NULL
      AND moderation_decision_id IS NULL)
    OR (source = 'safety_filter' AND reporter_id IS NULL AND content_id IS NULL
      AND moderation_decision_id IS NOT NULL)
  ),
  CONSTRAINT ck_ai_content_reports_reason_category
    CHECK (reason_category IN ('child_safety', 'unsafe', 'inappropriate', 'inaccurate', 'other')),
  CONSTRAINT ck_ai_content_reports_reason
    CHECK (reason IS NULL OR (btrim(reason) <> '' AND length(reason) <= 1000)),
  CONSTRAINT ck_ai_content_reports_priority
    CHECK (priority IN ('urgent', 'high', 'normal')),
  CONSTRAINT ck_ai_content_reports_status
    CHECK (status IN ('pending', 'in_review', 'escalated', 'actioned', 'dismissed')),
  CONSTRAINT ck_ai_content_reports_resolution_note
    CHECK (resolution_note IS NULL OR (btrim(resolution_note) <> '' AND length(resolution_note) <= 2000)),
  -- A report a moderator has touched says who and when; an untouched one says neither.
  CONSTRAINT ck_ai_content_reports_review
    CHECK ((status = 'pending') = (reviewed_by IS NULL AND reviewed_at IS NULL))
);

-- One report per reporter per item: a second tap is a 409, not a second queue row.
CREATE UNIQUE INDEX uq_ai_content_reports_reporter_content
  ON app.ai_content_reports (school_id, content_type, content_id, reporter_id)
  WHERE source = 'user_report';

-- The queue read: open reports by status, most urgent and soonest-due first.
CREATE INDEX idx_ai_content_reports_school_status_respond_by
  ON app.ai_content_reports (school_id, status, respond_by, id);

-- ---------------------------------------------------------------------------------------------------
-- 2. Carry the Ask AI reports over, then retire the old table
-- ---------------------------------------------------------------------------------------------------
--
-- ai_answer_reports.reporter_id referenced app.students; the new column references app.users, so
-- it is mapped through students.user_id. 'reviewed' had no recorded outcome, so it lands as
-- 'actioned' (the reviewer looked and closed it). Every carried row is 'other'/'normal': the old
-- form never asked for a category.

INSERT INTO app.ai_content_reports (
  id, school_id, student_id, content_type, content_id, content_snapshot, source, reporter_id,
  reason_category, reason, priority, respond_by, status, reviewed_by, reviewed_at, created_at,
  updated_at
)
SELECT
  r.id, r.school_id, r.student_id, 'ask_answer', r.message_id, m.answer, 'user_report', s.user_id,
  'other', left(btrim(r.reason), 1000), 'normal', r.created_at + interval '5 days',
  CASE r.status WHEN 'reviewed' THEN 'actioned' ELSE r.status END,
  CASE WHEN r.status = 'pending' THEN NULL ELSE r.reviewed_by END,
  CASE WHEN r.status = 'pending' THEN NULL ELSE coalesce(r.reviewed_at, r.created_at) END,
  r.created_at, coalesce(r.reviewed_at, r.created_at)
FROM app.ai_answer_reports r
JOIN app.ai_messages m ON m.id = r.message_id AND m.school_id = r.school_id
JOIN app.students s ON s.id = r.reporter_id AND s.school_id = r.school_id
-- A closed row with no reviewer cannot satisfy ck_ai_content_reports_review; the old table never
-- wrote one (no review endpoint existed), so this only guards against hand-edited data.
WHERE r.status = 'pending' OR r.reviewed_by IS NOT NULL;

DROP TABLE app.ai_answer_reports;

REVOKE ALL PRIVILEGES ON TABLE app.ai_content_reports FROM PUBLIC;
-- No DELETE: a report is part of the school's safeguarding record.
GRANT SELECT, INSERT, UPDATE ON TABLE app.ai_content_reports TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'ai_content_reports');

COMMENT ON TABLE app.ai_content_reports IS
  'AI content moderation queue (ST-306): user reports and safety-filter escalations of AI output, with the reported text snapshotted and a response deadline per priority.';

-- ---------------------------------------------------------------------------------------------------
-- 3. app.ai_moderation_decisions: surface + csam
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.ai_moderation_decisions
  ADD COLUMN surface text NOT NULL DEFAULT 'ask'
    CONSTRAINT ck_ai_moderation_decisions_surface
      CHECK (surface IN ('ask', 'quiz', 'flashcards', 'summary'));

ALTER TABLE app.ai_moderation_decisions
  DROP CONSTRAINT ai_moderation_decisions_category_check;

ALTER TABLE app.ai_moderation_decisions
  ADD CONSTRAINT ck_ai_moderation_decisions_category CHECK (category IN (
    'csam', 'self_harm', 'hate_speech', 'sexual_content', 'violence', 'profanity', 'pii_sharing'
  ));

RESET ROLE;
