-- Reporting in parent <-> teacher messaging, and the school's review queue for those reports:
-- app.message_reports plus a normalized evidence snapshot (app.message_report_messages,
-- app.message_report_attachments).
--
-- WHO FILES, WHO REVIEWS.
-- A participant reports the other participant -- one message, or the user in general -- under
-- message:read. Reports are worked by the holders of messageReport:review: ORG_ADMIN, SUPER_ADMIN
-- and PRINCIPAL (packages/constants/src/permissions.ts). The database mirrors that role list once,
-- in app.current_user_can_review_message_reports(); change both together.
--
-- EVIDENCE WITHOUT WIDENING MESSAGE RLS.
-- Reviewers are not participants, and app.messages deliberately has no administrator escape hatch.
-- Rather than open the messages to reviewers, the report carries a snapshot taken at filing time:
-- the reported message plus up to 20 messages before it (or the thread's last 20 when the user is
-- reported in general), with each sender's display name, and a row per attached image. The snapshot
-- is written by app.snapshot_message_report, a SECURITY DEFINER function that copies straight from
-- app.messages / app.message_attachments for a report the caller just filed: studafy_app holds no
-- INSERT on the snapshot tables, so evidence cannot be forged by a client that bypasses the API.
-- Images are referenced (attachment ids), not copied; a reviewer reaches their storage keys only
-- through app.message_report_attachment_objects, gated on the review role. Everything is relational
-- -- no jsonb -- so the RLS coverage audit's flexible-column rule does not apply.
--
-- THE WORKFLOW.
-- pending -> in_review -> {actioned | dismissed}, or pending -> {actioned | dismissed} directly
-- (apps/api/src/modules/messaging/reports.ts holds the transition table). `priority` is fixed by the
-- reason (ck_message_reports_priority) and `respond_by` at insert, so "overdue" is a plain
-- comparison. A reviewed row says who and when; a closed row says why (resolution_note). One OPEN
-- report per reporter per message (or per thread, for a general report): a second tap is a 409, but
-- the same message can be reported again once the first report is closed.
--
-- ROW SCOPE.
-- Tenant isolation is the outer boundary. Reports are readable by reviewers and by their own
-- reporter (so a client can show its status); writable by the reporter only as a fresh pending row
-- matching a thread they are in; updatable by reviewers only, on the review columns. No DELETE
-- grant anywhere: a report is part of the school's safeguarding record. Snapshot rows are readable
-- by reviewers alone.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Who reviews
-- ---------------------------------------------------------------------------------------------------

-- The roles holding messageReport:review. SECURITY DEFINER for the 000037 reason: it reads
-- app.user_roles from inside RESTRICTIVE policies.
CREATE FUNCTION app.current_user_can_review_message_reports()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.user_roles AS ur
    WHERE ur.school_id = current_setting('app.school_id')::uuid
      AND ur.user_id = app.scope_user_id()
      AND ur.role IN ('ORG_ADMIN', 'SUPER_ADMIN', 'PRINCIPAL')
  )
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 2. app.message_reports
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.message_reports (
  id               uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_message_reports PRIMARY KEY,
  school_id        uuid        NOT NULL,
  conversation_id  uuid        NOT NULL,
  -- The thread's child, copied from the thread at filing time: reviewers cannot read
  -- app.message_conversations (participant-only), and the queue shows who the thread is about.
  student_id       uuid        NOT NULL,
  -- NULL: the reporter is reporting the other participant in general, not one message.
  message_id       uuid,
  reporter_user_id uuid        NOT NULL,
  -- Which side of the thread the reporter is on; the reported user is the other side.
  reporter_role    text        NOT NULL,
  reported_user_id uuid        NOT NULL,
  reason_category  text        NOT NULL,
  details          text,
  priority         text        NOT NULL,
  respond_by       timestamptz NOT NULL,
  status           text        NOT NULL DEFAULT 'pending',
  resolution_note  text,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_message_reports_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_message_reports_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_reports_conversation
    FOREIGN KEY (conversation_id, school_id) REFERENCES app.message_conversations (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_reports_student
    FOREIGN KEY (student_id, school_id) REFERENCES app.students (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_reports_message
    FOREIGN KEY (message_id, school_id) REFERENCES app.messages (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_reports_reporter_user
    FOREIGN KEY (reporter_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_reports_reported_user
    FOREIGN KEY (reported_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_reports_reviewed_by
    FOREIGN KEY (reviewed_by, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_message_reports_distinct_users CHECK (reporter_user_id <> reported_user_id),
  CONSTRAINT ck_message_reports_reporter_role CHECK (reporter_role IN ('parent', 'teacher')),
  CONSTRAINT ck_message_reports_reason_category CHECK (
    reason_category IN ('harassment', 'inappropriate', 'spam', 'safety_concern', 'other')
  ),
  CONSTRAINT ck_message_reports_details CHECK (
    details IS NULL OR (details = btrim(details) AND details <> '' AND char_length(details) <= 1000)
  ),
  -- Priority follows from the reason; stated here so no writer can file a safety concern as normal.
  CONSTRAINT ck_message_reports_priority CHECK (
    priority = CASE reason_category
      WHEN 'safety_concern' THEN 'urgent'
      WHEN 'harassment' THEN 'high'
      WHEN 'inappropriate' THEN 'high'
      ELSE 'normal'
    END
  ),
  CONSTRAINT ck_message_reports_respond_by CHECK (respond_by > created_at),
  CONSTRAINT ck_message_reports_status CHECK (
    status IN ('pending', 'in_review', 'actioned', 'dismissed')
  ),
  CONSTRAINT ck_message_reports_resolution_note CHECK (
    resolution_note IS NULL
    OR (resolution_note = btrim(resolution_note) AND resolution_note <> ''
      AND char_length(resolution_note) <= 2000)
  ),
  -- A report a reviewer has touched says who and when; an untouched one says neither.
  CONSTRAINT ck_message_reports_review CHECK (
    (status = 'pending') = (reviewed_by IS NULL AND reviewed_at IS NULL)
  ),
  -- A closed report says why.
  CONSTRAINT ck_message_reports_closed_note CHECK (
    status NOT IN ('actioned', 'dismissed') OR resolution_note IS NOT NULL
  ),
  CONSTRAINT ck_message_reports_timestamps CHECK (updated_at >= created_at)
);

-- One open report per reporter per message, and per thread for a general report.
CREATE UNIQUE INDEX uq_message_reports_open_message
  ON app.message_reports (school_id, reporter_user_id, message_id)
  WHERE message_id IS NOT NULL AND status IN ('pending', 'in_review');
CREATE UNIQUE INDEX uq_message_reports_open_conversation
  ON app.message_reports (school_id, reporter_user_id, conversation_id)
  WHERE message_id IS NULL AND status IN ('pending', 'in_review');

-- The queue read: by status, soonest-due first.
CREATE INDEX idx_message_reports_school_status_respond_by
  ON app.message_reports (school_id, status, respond_by, id);
-- A reporter's own reports.
CREATE INDEX idx_message_reports_school_reporter
  ON app.message_reports (school_id, reporter_user_id, created_at DESC, id);

COMMENT ON TABLE app.message_reports IS
  'Parent<->teacher messaging reports and their review queue (000136); evidence is snapshotted into app.message_report_messages.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The evidence snapshot
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.message_report_messages (
  id                 uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_message_report_messages PRIMARY KEY,
  school_id          uuid        NOT NULL,
  report_id          uuid        NOT NULL,
  message_id         uuid        NOT NULL,
  -- Chronological order within the snapshot, 0-based (oldest first).
  position           smallint    NOT NULL,
  sender_user_id     uuid        NOT NULL,
  -- The sender's display name as it read at filing time.
  sender_name        text        NOT NULL,
  body               text        NOT NULL,
  message_created_at timestamptz NOT NULL,
  is_reported        boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_message_report_messages_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_message_report_messages_position UNIQUE (school_id, report_id, position),
  CONSTRAINT uq_message_report_messages_message UNIQUE (school_id, report_id, message_id),

  CONSTRAINT fk_message_report_messages_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_report_messages_report
    FOREIGN KEY (report_id, school_id) REFERENCES app.message_reports (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_report_messages_message
    FOREIGN KEY (message_id, school_id) REFERENCES app.messages (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_report_messages_sender_user
    FOREIGN KEY (sender_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_message_report_messages_position CHECK (position BETWEEN 0 AND 20),
  CONSTRAINT ck_message_report_messages_sender_name CHECK (sender_name <> ''),
  CONSTRAINT ck_message_report_messages_body CHECK (char_length(body) <= 2000)
);

CREATE TABLE app.message_report_attachments (
  id                uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_message_report_attachments PRIMARY KEY,
  school_id         uuid        NOT NULL,
  report_message_id uuid        NOT NULL,
  attachment_id     uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_message_report_attachments_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_message_report_attachments_attachment
    UNIQUE (school_id, report_message_id, attachment_id),

  CONSTRAINT fk_message_report_attachments_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_report_attachments_report_message
    FOREIGN KEY (report_message_id, school_id) REFERENCES app.message_report_messages (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_report_attachments_attachment
    FOREIGN KEY (attachment_id, school_id) REFERENCES app.message_attachments (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------------------------------------

-- Copies the evidence for a report the caller filed: the reported message and up to 20 before it,
-- or the thread's last 20 for a general report, then a row per image on those messages. Returns the
-- number of messages captured. SECURITY DEFINER because it is the only writer of the snapshot
-- tables (studafy_app holds no INSERT on them) and must read sender names the caller may not see.
-- Its reach: the current school, one report, filed by the caller, never snapshotted before.
CREATE FUNCTION app.snapshot_message_report(p_report_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_school_id uuid := current_setting('app.school_id')::uuid;
  v_report record;
  v_count integer;
BEGIN
  SELECT mr.id, mr.conversation_id, mr.message_id
  INTO v_report
  FROM app.message_reports AS mr
  WHERE mr.school_id = v_school_id
    AND mr.id = p_report_id
    AND mr.reporter_user_id = app.scope_user_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'message report % is not the caller''s', p_report_id
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.message_report_messages AS rm
    WHERE rm.school_id = v_school_id AND rm.report_id = v_report.id
  ) THEN
    RAISE EXCEPTION 'message report % already has a snapshot', p_report_id
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO app.message_report_messages (
    school_id, report_id, message_id, position, sender_user_id, sender_name, body,
    message_created_at, is_reported
  )
  SELECT
    v_school_id,
    v_report.id,
    picked.id,
    (row_number() OVER (ORDER BY picked.created_at, picked.id) - 1)::smallint,
    picked.sender_user_id,
    coalesce(nullif(btrim(u.display_name), ''), u.email),
    picked.body,
    picked.created_at,
    coalesce(picked.id = v_report.message_id, false)
  FROM (
    SELECT m.id, m.sender_user_id, m.body, m.created_at
    FROM app.messages AS m
    WHERE m.school_id = v_school_id
      AND m.conversation_id = v_report.conversation_id
      AND (
        v_report.message_id IS NULL
        OR (m.created_at, m.id) <= (
          SELECT anchor.created_at, anchor.id
          FROM app.messages AS anchor
          WHERE anchor.school_id = v_school_id AND anchor.id = v_report.message_id
        )
      )
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT CASE WHEN v_report.message_id IS NULL THEN 20 ELSE 21 END
  ) AS picked
  JOIN app.users AS u ON u.id = picked.sender_user_id AND u.school_id = v_school_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO app.message_report_attachments (school_id, report_message_id, attachment_id)
  SELECT v_school_id, rm.id, ma.id
  FROM app.message_report_messages AS rm
  JOIN app.message_attachments AS ma
    ON ma.school_id = rm.school_id AND ma.message_id = rm.message_id
  WHERE rm.school_id = v_school_id AND rm.report_id = v_report.id;

  RETURN v_count;
END
$function$;

-- The stored objects behind a report's snapshot images, for the reviewer's pre-signed downloads.
-- SECURITY DEFINER because app.message_attachments is participant-only; gated on the review role.
CREATE FUNCTION app.message_report_attachment_objects(p_report_id uuid)
RETURNS TABLE (
  report_message_id uuid,
  attachment_id uuid,
  attachment_position smallint,
  mime_type text,
  size_bytes bigint,
  storage_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT rm.id, ma.id, ma.position, ma.mime_type, ma.size_bytes, ma.storage_key
  FROM app.message_report_messages AS rm
  JOIN app.message_report_attachments AS ra
    ON ra.school_id = rm.school_id AND ra.report_message_id = rm.id
  JOIN app.message_attachments AS ma
    ON ma.school_id = ra.school_id AND ma.id = ra.attachment_id
  WHERE rm.school_id = current_setting('app.school_id')::uuid
    AND rm.report_id = p_report_id
    AND app.current_user_can_review_message_reports()
  ORDER BY rm.position, ma.position
$function$;

-- Reviewers see whether a block stands between a report's two users. CREATE OR REPLACE keeps the
-- owner and the EXECUTE grant from 000135.
CREATE OR REPLACE FUNCTION app.message_block_between(p_user_a uuid, p_user_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT (
      coalesce(app.scope_user_id() IN (p_user_a, p_user_b), false)
      OR app.current_user_can_review_message_reports()
    )
    AND EXISTS (
      SELECT 1
      FROM app.message_blocks AS mb
      WHERE mb.school_id = current_setting('app.school_id')::uuid
        AND (
          (mb.blocker_user_id = p_user_a AND mb.blocked_user_id = p_user_b)
          OR (mb.blocker_user_id = p_user_b AND mb.blocked_user_id = p_user_a)
        )
    )
$function$;

ALTER FUNCTION app.current_user_can_review_message_reports() OWNER TO studafy_admin;
ALTER FUNCTION app.snapshot_message_report(uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.message_report_attachment_objects(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION
  app.current_user_can_review_message_reports(),
  app.snapshot_message_report(uuid),
  app.message_report_attachment_objects(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.current_user_can_review_message_reports(),
  app.snapshot_message_report(uuid),
  app.message_report_attachment_objects(uuid)
TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 5. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

-- studafy_app named explicitly: 000002's default privileges would otherwise leave full DML in place
-- (DELETE on the safeguarding record, INSERT on the evidence snapshot).
REVOKE ALL PRIVILEGES ON TABLE
  app.message_reports, app.message_report_messages, app.message_report_attachments
FROM PUBLIC, studafy_app;
-- No DELETE anywhere: a report is part of the school's safeguarding record.
GRANT SELECT, INSERT ON TABLE app.message_reports TO studafy_app;
GRANT UPDATE (status, resolution_note, reviewed_by, reviewed_at, updated_at)
  ON TABLE app.message_reports TO studafy_app;
-- Snapshot rows are written only by app.snapshot_message_report.
GRANT SELECT ON TABLE app.message_report_messages, app.message_report_attachments TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'message_reports');
SELECT app.apply_tenant_isolation('app', 'message_report_messages');
SELECT app.apply_tenant_isolation('app', 'message_report_attachments');

CREATE POLICY message_reports_reviewer_or_reporter_select ON app.message_reports
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    reporter_user_id = app.scope_user_id()
    OR app.current_user_can_review_message_reports()
  );

-- A fresh pending report, filed by the caller as themselves, against the other participant of a
-- thread they are in, naming that thread's child and (optionally) one of its messages. The
-- subqueries are filtered by the participant SELECT policies of 000127, which never read
-- app.message_reports: no recursion.
CREATE POLICY message_reports_reporter_insert ON app.message_reports
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (
    reporter_user_id = app.scope_user_id()
    AND status = 'pending'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND resolution_note IS NULL
    AND EXISTS (
      SELECT 1
      FROM app.message_conversations AS mc
      WHERE mc.id = message_reports.conversation_id
        AND mc.school_id = message_reports.school_id
        AND mc.student_id = message_reports.student_id
        AND (
          (message_reports.reporter_role = 'parent'
            AND mc.parent_user_id = message_reports.reporter_user_id
            AND mc.teacher_user_id = message_reports.reported_user_id)
          OR (message_reports.reporter_role = 'teacher'
            AND mc.teacher_user_id = message_reports.reporter_user_id
            AND mc.parent_user_id = message_reports.reported_user_id)
        )
    )
    AND (
      message_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM app.messages AS m
        WHERE m.id = message_reports.message_id
          AND m.school_id = message_reports.school_id
          AND m.conversation_id = message_reports.conversation_id
      )
    )
  );

CREATE POLICY message_reports_reviewer_update ON app.message_reports
  AS RESTRICTIVE FOR UPDATE TO studafy_app
  USING (app.current_user_can_review_message_reports())
  WITH CHECK (app.current_user_can_review_message_reports());

CREATE POLICY message_report_messages_reviewer_select ON app.message_report_messages
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.current_user_can_review_message_reports());

CREATE POLICY message_report_attachments_reviewer_select ON app.message_report_attachments
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.current_user_can_review_message_reports());

RESET ROLE;
