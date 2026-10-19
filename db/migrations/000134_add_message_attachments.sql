-- Image attachments on parent <-> teacher messages (000127): app.message_attachments, one row per
-- stored image, up to four per message.
--
-- THE UPLOAD FLOW.
-- The client stages each image through the generic storage gateway (POST
-- /api/storage/uploads/request-upload with content_class `message.attachment`), PUTs the bytes to
-- the signed URL, then sends the message naming the staged temp/ keys. The send transaction
-- re-checks each stored object's type and size against the content class, promotes it to
-- permanent/<school_id>/..., and inserts these rows next to the message -- the message and its
-- images commit together or not at all.
--
-- THE STORAGE KEY CHECK IS A TENANT BOUNDARY, NOT A FORMAT CHECK -- the same rule
-- ck_assignment_attachments_storage_key (000049) states: a persisted key is pinned to
-- '^permanent/<this row's school_id>/...', the half of the boundary that still holds if the API's
-- assertSchoolOwnedKey is bypassed.
--
-- AT MOST FOUR PER MESSAGE, IN THE DATABASE.
-- `position` is 0..3 and unique per message, so a fifth row cannot exist however it is written.
-- The same unique constraint is the school-leading index the per-page hydration walks.
--
-- ROW SCOPE.
-- Tenant isolation is the outer boundary. Inside the school an attachment is exactly as visible as
-- its message: RESTRICTIVE policies TO studafy_app admit a row only to the two participants of the
-- message's thread (no administrator escape hatch, as for app.messages), and accept an INSERT only
-- from the message's own sender, inside the transaction that wrote the message -- an image can
-- never be bolted onto a message after the fact, so the thread history the other participant read
-- stays the history. Append-only like app.messages: SELECT, INSERT only.
--
-- APPEND-ONLY, ACTUALLY (a fix to 000127).
-- 000127 meant app.messages to be SELECT/INSERT-only and app.message_conversations' UPDATE to be
-- column-level, but it revoked only FROM PUBLIC. 000002's ALTER DEFAULT PRIVILEGES grants studafy_app
-- SELECT, INSERT, UPDATE, DELETE on every table studafy_admin creates in app, so that table-level
-- DML survived -- and with no restrictive UPDATE/DELETE policy on app.messages, a participant could
-- rewrite or delete either side's messages. Both tables are re-granted here with studafy_app named
-- explicitly, the 000062/000065 pattern; this file's new table does the same.
--
-- EMPTY BODIES.
-- ck_messages_body relaxes from 1..2000 to 0..2000 characters (still trimmed, still NOT NULL): an
-- image-only message carries the empty string. "A body, or at least one image" spans two tables
-- and is enforced by the API before it inserts either.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. app.messages: an image-only message has an empty body
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.messages DROP CONSTRAINT ck_messages_body;
ALTER TABLE app.messages ADD CONSTRAINT ck_messages_body CHECK (
  body = btrim(body) AND char_length(body) <= 2000
);

-- ---------------------------------------------------------------------------------------------------
-- 2. app.message_attachments
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.message_attachments (
  id                 uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_message_attachments PRIMARY KEY,
  school_id          uuid        NOT NULL,
  message_id         uuid        NOT NULL,
  -- Display order within the message, 0-based; also the four-per-message ceiling.
  position           smallint    NOT NULL,
  storage_key        text        NOT NULL,
  original_file_name text        NOT NULL,
  mime_type          text        NOT NULL,
  size_bytes         bigint      NOT NULL,
  checksum_sha256    text,
  created_at         timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_message_attachments_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_message_attachments_storage_key UNIQUE (storage_key),
  CONSTRAINT uq_message_attachments_message_position UNIQUE (school_id, message_id, position),

  CONSTRAINT fk_message_attachments_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- RESTRICT: messages are append-only and never deleted, so neither are their images.
  CONSTRAINT fk_message_attachments_message
    FOREIGN KEY (message_id, school_id) REFERENCES app.messages (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_message_attachments_position CHECK (position BETWEEN 0 AND 3),
  CONSTRAINT ck_message_attachments_storage_key CHECK (
    storage_key = btrim(storage_key)
    AND storage_key ~ ('^permanent/' || school_id::text || '/[^/]+/[^/]+$')
  ),
  CONSTRAINT ck_message_attachments_original_file_name CHECK (
    original_file_name = btrim(original_file_name) AND original_file_name <> ''
    AND char_length(original_file_name) <= 255
    AND original_file_name !~ '[/\\]'
  ),
  -- Mirrors the `message.attachment` content class (apps/api/src/modules/storage/content-classes.ts).
  CONSTRAINT ck_message_attachments_mime_type CHECK (
    mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic')
  ),
  CONSTRAINT ck_message_attachments_size CHECK (size_bytes > 0),
  CONSTRAINT ck_message_attachments_checksum CHECK (
    checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'
  )
);

COMMENT ON TABLE app.message_attachments IS
  'Images attached to parent<->teacher messages (000134): at most four per message, visible to the thread''s two participants only.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Functions
-- ---------------------------------------------------------------------------------------------------

-- True when the caller is a participant in the thread `p_message_id` belongs to. SECURITY DEFINER
-- for the reason the 000037 helpers are: it is called from a RESTRICTIVE policy and reads
-- app.messages / app.message_conversations, whose own restrictive policies would otherwise be
-- re-entered. Read-only and pinned to current_setting('app.school_id').
CREATE FUNCTION app.current_user_participates_in_message(p_message_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.messages AS m
    JOIN app.message_conversations AS mc
      ON mc.id = m.conversation_id AND mc.school_id = m.school_id
    WHERE m.school_id = current_setting('app.school_id')::uuid
      AND m.id = p_message_id
      AND app.scope_user_id() IN (mc.parent_user_id, mc.teacher_user_id)
  )
$function$;

-- True when the caller sent `p_message_id` in the current transaction. messages.created_at is
-- clock_timestamp() truncated to the millisecond, so a message written by this transaction is
-- never older than the transaction's own start truncated the same way; any earlier message is.
CREATE FUNCTION app.current_user_can_attach_to_message(p_message_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.messages AS m
    WHERE m.school_id = current_setting('app.school_id')::uuid
      AND m.id = p_message_id
      AND m.sender_user_id = app.scope_user_id()
      AND m.created_at >= date_trunc('milliseconds', transaction_timestamp())
  )
$function$;

ALTER FUNCTION app.current_user_participates_in_message(uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.current_user_can_attach_to_message(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION
  app.current_user_participates_in_message(uuid),
  app.current_user_can_attach_to_message(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.current_user_participates_in_message(uuid),
  app.current_user_can_attach_to_message(uuid)
TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.message_attachments FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT ON TABLE app.message_attachments TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'message_attachments');

CREATE POLICY message_attachments_participant_select ON app.message_attachments
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.current_user_participates_in_message(message_id));

CREATE POLICY message_attachments_sender_insert ON app.message_attachments
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (app.current_user_can_attach_to_message(message_id));

-- ---------------------------------------------------------------------------------------------------
-- 5. 000127's tables: the grants it intended
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.messages, app.message_conversations FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT ON TABLE app.messages, app.message_conversations TO studafy_app;
GRANT UPDATE (last_message_at, parent_last_read_at, teacher_last_read_at, updated_at)
  ON TABLE app.message_conversations TO studafy_app;

RESET ROLE;
