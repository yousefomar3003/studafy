-- Parent <-> teacher 1-to-1 messaging: app.message_conversations (one thread per school, parent,
-- teacher and child) and app.messages (the append-only messages in a thread).
--
-- Served by apps/api/src/modules/messaging under the message:read / message:send permissions held
-- by PARENT, INSTRUCTOR and TEACHING_ASSISTANT (packages/constants/src/permissions.ts). A new message
-- notifies the other participant through app.notifications with the DIRECT_MESSAGE type (000126).
--
-- WHO MAY TALK TO WHOM.
-- A parent may open a thread with a teacher only about a child linked to them in
-- app.parent_child_links, and only with a teacher who teaches a class that child is currently enrolled
-- in. "Teaches" means the class's lead teacher, or a teacher holding a slot for the class in an
-- approved (live) timetable version -- the same two relationships app.teaches_class (000037) reads,
-- narrowed to the live timetable so a draft slot cannot open a channel. "Currently enrolled" means an
-- active enrollment in a planned or active class. The teacher must also be an active user holding
-- INSTRUCTOR or TEACHING_ASSISTANT, the roles that carry message:read, so a thread is never opened
-- with someone who could not answer it. The rule lives once, in
-- app.can_message_teacher_about_student below: the parent INSERT policy calls it, and the API calls
-- the same function before inserting so it can answer 403 rather than surface a policy violation.
-- It is checked when a thread is opened, not on every message: a thread outlives the term that
-- created it, so both participants keep their history after the child changes class.
--
-- ROW SCOPE.
-- Tenant isolation is the outer boundary (apply_tenant_isolation). Inside the school, RESTRICTIVE
-- policies TO studafy_app limit every read and write to the thread's two participants -- no
-- administrator escape hatch: these are private conversations, and nothing in the product reads
-- them on anyone else's behalf. Messages inherit their thread's scope: a message is readable or
-- insertable only through a thread the caller participates in, and only ever as its own sender.
--
-- WHAT studafy_app MAY CHANGE.
-- Messages are append-only (SELECT, INSERT only; no UPDATE or DELETE grant), the same rule
-- app.ai_messages (000021) follows. A thread's identity -- its school, parent, teacher and child --
-- is fixed at creation: the UPDATE grant is column-level, covering only the activity and read-marker
-- columns, so a participant cannot re-point a thread at another child or teacher.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.message_conversations (
  id                   uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_message_conversations PRIMARY KEY,
  school_id            uuid        NOT NULL,
  parent_user_id       uuid        NOT NULL,
  teacher_user_id      uuid        NOT NULL,
  student_id           uuid        NOT NULL,
  -- Last activity on the thread: the newest message's created_at, or the thread's creation time
  -- before anything is sent. NOT NULL so the inbox orders by one plain indexed column.
  last_message_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  parent_last_read_at  timestamptz,
  teacher_last_read_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_message_conversations_id_school UNIQUE (id, school_id),
  -- One thread per (school, parent, teacher, child). The API's get-or-create relies on it.
  CONSTRAINT uq_message_conversations_participants
    UNIQUE (school_id, parent_user_id, teacher_user_id, student_id),

  CONSTRAINT fk_message_conversations_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_conversations_parent_user
    FOREIGN KEY (parent_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_conversations_teacher_user
    FOREIGN KEY (teacher_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_conversations_student
    FOREIGN KEY (student_id, school_id) REFERENCES app.students (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_message_conversations_distinct_participants CHECK (parent_user_id <> teacher_user_id),
  CONSTRAINT ck_message_conversations_last_message_at CHECK (last_message_at >= created_at),
  CONSTRAINT ck_message_conversations_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.messages (
  id              uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_messages PRIMARY KEY,
  school_id       uuid        NOT NULL,
  conversation_id uuid        NOT NULL,
  sender_user_id  uuid        NOT NULL,
  body            text        NOT NULL,
  -- Millisecond precision on purpose. Clients poll with `since` = the newest created_at they hold,
  -- serialized as an ISO-8601 string with millisecond precision; a microsecond-precision value would
  -- compare strictly greater than its own truncated echo and be re-delivered on every poll.
  created_at      timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),

  CONSTRAINT uq_messages_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_messages_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_messages_conversation
    FOREIGN KEY (conversation_id, school_id) REFERENCES app.message_conversations (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_messages_sender_user
    FOREIGN KEY (sender_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_messages_body CHECK (
    body = btrim(body) AND char_length(body) BETWEEN 1 AND 2000
  )
);

-- ---------------------------------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------------------------------

-- The inbox, newest activity first, from either side of the thread. school_id leads for the tenant
-- predicate; id breaks ties between threads touched in the same instant.
CREATE INDEX idx_message_conversations_school_parent_last_message
  ON app.message_conversations (school_id, parent_user_id, last_message_at DESC, id DESC);
CREATE INDEX idx_message_conversations_school_teacher_last_message
  ON app.message_conversations (school_id, teacher_user_id, last_message_at DESC, id DESC);

-- A thread's messages in order: the latest page, older pages (before), newer ones (since), the
-- last-message preview, and the unread count all walk this index.
CREATE INDEX idx_messages_school_conversation_created_at
  ON app.messages (school_id, conversation_id, created_at, id);

-- ---------------------------------------------------------------------------------------------------
-- 3. Functions
-- ---------------------------------------------------------------------------------------------------

-- True when `p_parent_user_id` may open a thread with `p_teacher_user_id` about `p_student_id` in the
-- current school (see "WHO MAY TALK TO WHOM" above). SECURITY DEFINER for the reason every 000037
-- helper is: it reads relationship tables (enrollments, classes, timetable_slots) whose restrictive
-- role_scope_visibility policies would otherwise recurse or hide rows the rule needs. Read-only and
-- pinned to current_setting('app.school_id'), so it cannot cross a tenant boundary.
CREATE FUNCTION app.can_message_teacher_about_student(
  p_parent_user_id uuid,
  p_teacher_user_id uuid,
  p_student_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT
    EXISTS (
      SELECT 1
      FROM app.parent_child_links AS pcl
      WHERE pcl.school_id = current_setting('app.school_id')::uuid
        AND pcl.parent_user_id = p_parent_user_id
        AND pcl.student_id = p_student_id
    )
    AND EXISTS (
      SELECT 1
      FROM app.users AS u
      JOIN app.user_roles AS ur ON ur.user_id = u.id AND ur.school_id = u.school_id
      WHERE u.school_id = current_setting('app.school_id')::uuid
        AND u.id = p_teacher_user_id
        AND u.status = 'active'
        AND ur.role IN ('INSTRUCTOR', 'TEACHING_ASSISTANT')
    )
    AND EXISTS (
      SELECT 1
      FROM app.enrollments AS e
      JOIN app.classes AS c ON c.id = e.class_id AND c.school_id = e.school_id
      JOIN app.teachers AS t ON t.school_id = e.school_id AND t.user_id = p_teacher_user_id
      WHERE e.school_id = current_setting('app.school_id')::uuid
        AND e.student_id = p_student_id
        AND e.status = 'active'
        AND c.status IN ('planned', 'active')
        AND (
          c.lead_teacher_id = t.id
          OR EXISTS (
            SELECT 1
            FROM app.timetable_slots AS ts
            JOIN app.timetable_versions AS tv
              ON tv.id = ts.timetable_version_id AND tv.school_id = ts.school_id
            WHERE ts.school_id = c.school_id
              AND ts.class_id = c.id
              AND ts.teacher_id = t.id
              AND tv.status = 'approved'
          )
        )
    )
$function$;

-- Display names for the children of the caller's own threads. A teacher's read of app.students is
-- scoped by role_scope_visibility to the children they currently teach, so once a child moves class
-- the thread would lose its subject's name; this keeps it, and only it: a student is resolved only
-- when a thread in the current school names them and the caller is one of its participants.
CREATE FUNCTION app.message_conversation_student_names(p_student_ids uuid[])
RETURNS TABLE (student_id uuid, display_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT s.id, coalesce(s.preferred_name, s.first_name) || ' ' || s.last_name
  FROM app.students AS s
  WHERE s.school_id = current_setting('app.school_id')::uuid
    AND s.id = ANY (p_student_ids)
    AND EXISTS (
      SELECT 1
      FROM app.message_conversations AS mc
      WHERE mc.school_id = s.school_id
        AND mc.student_id = s.id
        AND app.scope_user_id() IN (mc.parent_user_id, mc.teacher_user_id)
    )
$function$;

-- How to notify the other participant of a new message: whether they have left the DIRECT_MESSAGE
-- type enabled on the in_app channel (a missing preference row means enabled, the 000017 seeding
-- trigger's default) and which locale to render it in (their own, else the school's). Both live in
-- rows that belong to another user -- notification_preferences_owner (000017) and the per-user
-- settings policy hide them from studafy_app -- hence SECURITY DEFINER, the same reason
-- app.get_announcement_opted_out_users (000105) exists. Its reach is bounded the same way: read-only,
-- pinned to current_setting('app.school_id'), hardcoded to the one type/channel pair messaging
-- checks, and answering only for a user who shares a thread with the caller.
CREATE FUNCTION app.direct_message_recipient_settings(p_user_id uuid)
RETURNS TABLE (in_app_enabled boolean, locale text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT
    NOT EXISTS (
      SELECT 1
      FROM app.notification_preferences AS np
      WHERE np.school_id = u.school_id
        AND np.user_id = u.id
        AND np.notification_type::text = 'DIRECT_MESSAGE'
        AND np.channel = 'in_app'
        AND np.enabled = false
    ),
    coalesce(settings.locale, school_settings.locale)
  FROM app.users AS u
  LEFT JOIN app.user_notification_settings AS settings
    ON settings.user_id = u.id AND settings.school_id = u.school_id
  LEFT JOIN app.school_settings AS school_settings
    ON school_settings.school_id = u.school_id
  WHERE u.school_id = current_setting('app.school_id')::uuid
    AND u.id = p_user_id
    AND EXISTS (
      SELECT 1
      FROM app.message_conversations AS mc
      WHERE mc.school_id = u.school_id
        AND (
          (mc.parent_user_id = app.scope_user_id() AND mc.teacher_user_id = u.id)
          OR (mc.teacher_user_id = app.scope_user_id() AND mc.parent_user_id = u.id)
        )
    )
$function$;

ALTER FUNCTION app.can_message_teacher_about_student(uuid, uuid, uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.message_conversation_student_names(uuid[]) OWNER TO studafy_admin;
ALTER FUNCTION app.direct_message_recipient_settings(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION
  app.can_message_teacher_about_student(uuid, uuid, uuid),
  app.message_conversation_student_names(uuid[]),
  app.direct_message_recipient_settings(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.can_message_teacher_about_student(uuid, uuid, uuid),
  app.message_conversation_student_names(uuid[]),
  app.direct_message_recipient_settings(uuid)
TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.message_conversations, app.messages FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE app.message_conversations, app.messages TO studafy_app;
GRANT UPDATE (last_message_at, parent_last_read_at, teacher_last_read_at, updated_at)
  ON TABLE app.message_conversations TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'message_conversations');
SELECT app.apply_tenant_isolation('app', 'messages');

-- Threads: readable and updatable by their two participants only.
CREATE POLICY message_conversations_participant_select ON app.message_conversations
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.scope_user_id() IN (parent_user_id, teacher_user_id));

CREATE POLICY message_conversations_participant_update ON app.message_conversations
  AS RESTRICTIVE FOR UPDATE TO studafy_app
  USING (app.scope_user_id() IN (parent_user_id, teacher_user_id))
  WITH CHECK (app.scope_user_id() IN (parent_user_id, teacher_user_id));

-- Only the parent opens a thread, as themselves, and only one the messaging rule allows.
CREATE POLICY message_conversations_parent_insert ON app.message_conversations
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (
    parent_user_id = app.scope_user_id()
    AND app.can_message_teacher_about_student(parent_user_id, teacher_user_id, student_id)
  );

-- Messages: visible through a thread the caller participates in; written only by a participant, as
-- themselves. The subquery is itself filtered by message_conversations_participant_select, and that
-- policy never reads app.messages, so there is no recursion.
CREATE POLICY messages_participant_select ON app.messages
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    EXISTS (
      SELECT 1
      FROM app.message_conversations AS mc
      WHERE mc.id = messages.conversation_id
        AND mc.school_id = messages.school_id
        AND app.scope_user_id() IN (mc.parent_user_id, mc.teacher_user_id)
    )
  );

CREATE POLICY messages_participant_insert ON app.messages
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (
    sender_user_id = app.scope_user_id()
    AND EXISTS (
      SELECT 1
      FROM app.message_conversations AS mc
      WHERE mc.id = messages.conversation_id
        AND mc.school_id = messages.school_id
        AND app.scope_user_id() IN (mc.parent_user_id, mc.teacher_user_id)
    )
  );

RESET ROLE;
