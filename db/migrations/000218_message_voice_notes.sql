-- Voice notes in parent<->teacher chats.
--
-- A voice note is a message attachment like an image (000134): staged through the generic
-- request-upload route (content class `message.voice`), confirmed and promoted by the send itself,
-- malware-scanned (000192), counted against the school's storage pool and protected from orphan
-- cleanup by app.referenced_storage_keys (000204), which already covers app.message_attachments.
-- So the table gains audio types and a duration instead of a second table:
--
--   * mime_type: audio/mp4 (AAC in an .m4a container, what the app records) and audio/aac.
--   * duration_ms: required for audio, absent for images. 1 ms to 121 s: the app stops recording
--     at 120 s and the recorder can overshoot by a frame. The server cannot cheaply verify it; the
--     content class's 2 MiB size cap is what actually bounds a note (~120 s at 64 kbps).
--   * A voice note is the only attachment on its message (position 0); the API enforces that.
--
-- school_settings.allow_voice_notes (default on) lets a school turn sending them off. Notes already
-- sent stay playable. Default on: the people messaging are parents and teachers (adults; students
-- have no chat), every note is visible only to the thread's two participants, reportable, scanned
-- and retained like any message, and many parents find speaking easier than typing.
--
-- app.message_report_attachment_objects gains duration_ms so a reviewer can play a reported note
-- with its length. Its result type changes, so it is dropped and recreated with the same body,
-- owner and grants as 000192.

SET ROLE studafy_admin;

ALTER TABLE app.message_attachments
  ADD COLUMN duration_ms integer;

ALTER TABLE app.message_attachments DROP CONSTRAINT ck_message_attachments_mime_type;
-- Mirrors the `message.attachment` and `message.voice` content classes
-- (apps/api/src/modules/storage/content-classes.ts).
ALTER TABLE app.message_attachments ADD CONSTRAINT ck_message_attachments_mime_type CHECK (
  mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'audio/mp4', 'audio/aac')
);
ALTER TABLE app.message_attachments ADD CONSTRAINT ck_message_attachments_duration CHECK (
  CASE
    WHEN mime_type LIKE 'audio/%' THEN duration_ms IS NOT NULL AND duration_ms BETWEEN 1 AND 121000
    ELSE duration_ms IS NULL
  END
);

COMMENT ON COLUMN app.message_attachments.duration_ms IS
  'Length of a voice note in milliseconds (000218); NULL for an image.';

ALTER TABLE app.school_settings
  ADD COLUMN allow_voice_notes boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN app.school_settings.allow_voice_notes IS
  'When true, parents and teachers can send voice notes in chats (000218). Notes already sent stay playable.';

DROP FUNCTION app.message_report_attachment_objects(uuid);

CREATE FUNCTION app.message_report_attachment_objects(p_report_id uuid)
RETURNS TABLE (
  report_message_id uuid,
  attachment_id uuid,
  attachment_position smallint,
  mime_type text,
  size_bytes bigint,
  storage_key text,
  duration_ms integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT rm.id, ma.id, ma.position, ma.mime_type, ma.size_bytes,
         CASE WHEN ma.scan_status IN ('clean', 'unscanned') THEN ma.storage_key END,
         ma.duration_ms
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

ALTER FUNCTION app.message_report_attachment_objects(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.message_report_attachment_objects(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.message_report_attachment_objects(uuid) TO studafy_app;

RESET ROLE;
