-- Blocking in parent <-> teacher messaging (000127): app.message_blocks, one row per (blocker,
-- blocked) pair in a school.
--
-- WHAT A BLOCK DOES.
-- While a block exists in EITHER direction between two users, neither may send the other a message
-- nor open a new thread with them. Existing history stays readable to both: a block stops the
-- conversation, it does not erase it (messages are append-only and the thread is a record).
--
-- WHERE IT IS ENFORCED.
-- The API checks first, so it can answer 403 MESSAGING_BLOCKED instead of surfacing a policy
-- violation. The database enforces it again: the RESTRICTIVE INSERT policies on app.messages and
-- app.message_conversations are replaced (PostgreSQL ANDs restrictive policies, so a second policy
-- would not be a narrowing of the first by itself -- it is cleanest to restate each one whole, with
-- every existing condition kept) to add NOT app.message_block_between(parent, teacher).
--
-- ROW SCOPE.
-- A block is the blocker's own state. RESTRICTIVE policies TO studafy_app let a user read, create
-- and remove only the blocks they placed, and create one only against someone they share a thread
-- with -- a block is never a way to probe or tag arbitrary users. Whether the OTHER side has blocked
-- the caller is answered by two SECURITY DEFINER helpers, each confined to a pair the caller is
-- part of: app.message_block_between (either direction, for the send path and the policies) and
-- app.message_user_has_blocked_me. Grants: SELECT, INSERT, DELETE (unblocking deletes the row; there
-- is nothing to update).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. app.message_blocks
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.message_blocks (
  id              uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_message_blocks PRIMARY KEY,
  school_id       uuid        NOT NULL,
  blocker_user_id uuid        NOT NULL,
  blocked_user_id uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_message_blocks_id_school UNIQUE (id, school_id),
  -- One block per direction; the API's idempotent block relies on it. Also the blocker-side index.
  CONSTRAINT uq_message_blocks_pair UNIQUE (school_id, blocker_user_id, blocked_user_id),

  CONSTRAINT fk_message_blocks_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_blocks_blocker_user
    FOREIGN KEY (blocker_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_message_blocks_blocked_user
    FOREIGN KEY (blocked_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_message_blocks_distinct_users CHECK (blocker_user_id <> blocked_user_id)
);

-- The reverse direction ("has this user blocked me?"), read by the helpers below.
CREATE INDEX idx_message_blocks_school_blocked
  ON app.message_blocks (school_id, blocked_user_id, blocker_user_id);

COMMENT ON TABLE app.message_blocks IS
  'Parent<->teacher messaging blocks (000135): a block in either direction stops new messages and new threads between the pair.';

-- ---------------------------------------------------------------------------------------------------
-- 2. Functions
-- ---------------------------------------------------------------------------------------------------

-- True when a block exists in either direction between `p_user_a` and `p_user_b` in the current
-- school. SECURITY DEFINER because the caller can see only the blocks they placed, and the send
-- path must also see the ones placed against them. Answers only for a pair the caller is part of
-- (a non-member always gets false), so it cannot be used to discover other users' blocks.
-- 000136 widens the guard to message-report reviewers.
CREATE FUNCTION app.message_block_between(p_user_a uuid, p_user_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT coalesce(app.scope_user_id() IN (p_user_a, p_user_b), false)
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

-- True when `p_user_id` has blocked the caller.
CREATE FUNCTION app.message_user_has_blocked_me(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.message_blocks AS mb
    WHERE mb.school_id = current_setting('app.school_id')::uuid
      AND mb.blocker_user_id = p_user_id
      AND mb.blocked_user_id = app.scope_user_id()
  )
$function$;

ALTER FUNCTION app.message_block_between(uuid, uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.message_user_has_blocked_me(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION
  app.message_block_between(uuid, uuid),
  app.message_user_has_blocked_me(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.message_block_between(uuid, uuid),
  app.message_user_has_blocked_me(uuid)
TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 3. Grants and RLS on app.message_blocks
-- ---------------------------------------------------------------------------------------------------

-- studafy_app named explicitly: 000002's default privileges would otherwise leave UPDATE in place.
REVOKE ALL PRIVILEGES ON TABLE app.message_blocks FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, DELETE ON TABLE app.message_blocks TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'message_blocks');

CREATE POLICY message_blocks_blocker_select ON app.message_blocks
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (blocker_user_id = app.scope_user_id());

-- Only against someone the caller shares a thread with. The subquery is filtered by
-- message_conversations_participant_select, which never reads app.message_blocks: no recursion.
CREATE POLICY message_blocks_blocker_insert ON app.message_blocks
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (
    blocker_user_id = app.scope_user_id()
    AND EXISTS (
      SELECT 1
      FROM app.message_conversations AS mc
      WHERE mc.school_id = message_blocks.school_id
        AND (
          (mc.parent_user_id = message_blocks.blocker_user_id
            AND mc.teacher_user_id = message_blocks.blocked_user_id)
          OR (mc.teacher_user_id = message_blocks.blocker_user_id
            AND mc.parent_user_id = message_blocks.blocked_user_id)
        )
    )
  );

CREATE POLICY message_blocks_blocker_delete ON app.message_blocks
  AS RESTRICTIVE FOR DELETE TO studafy_app
  USING (blocker_user_id = app.scope_user_id());

-- ---------------------------------------------------------------------------------------------------
-- 4. A blocked pair cannot write to each other, even bypassing the API
-- ---------------------------------------------------------------------------------------------------

-- Restated from 000127 with the block clause added.
DROP POLICY messages_participant_insert ON app.messages;

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
        AND NOT app.message_block_between(mc.parent_user_id, mc.teacher_user_id)
    )
  );

-- Restated from 000130 with the block clause added.
DROP POLICY message_conversations_participant_insert ON app.message_conversations;

CREATE POLICY message_conversations_participant_insert ON app.message_conversations
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (
    app.scope_user_id() IN (parent_user_id, teacher_user_id)
    AND app.can_message_teacher_about_student(parent_user_id, teacher_user_id, student_id)
    AND NOT app.message_block_between(parent_user_id, teacher_user_id)
  );

RESET ROLE;
