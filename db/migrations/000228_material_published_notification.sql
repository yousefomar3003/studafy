-- studafy:migration transaction=off
--
-- Tell a class's students when a teacher's material becomes visible to them.
--
-- Until now an upload told only the uploader how it went (MATERIAL_INGESTED and friends); the
-- students it was for heard nothing. A student or parent sees a material only once it is `ready`
-- (material-service.ts listMaterials/getMaterial with readyOnly, and the download path), and a
-- material reaches `ready` along several paths:
--
--   * the scan worker's clean verdict, for a material that is not AI-bound (AI off on the material
--     or on its class);
--   * the ai-ingestion worker finishing, for one that is;
--   * the ai-ingestion worker holding it back because its class's AI setting went off mid-way;
--   * the teacher turning AI off while it waits for or is in ingestion (toggleAiVisible).
--
-- And it can leave `ready` and come back: turning AI on (for the material or its class) re-stages a
-- ready material to `queued`, and ingestion brings it back to `ready`. That is not news to anyone.
--
-- So the moment is the database's, not any one caller's: the first time a material's ingest_status
-- becomes `ready`, whichever path did it. This migration makes that one event:
--
-- ## 1. app.notification_type gains MATERIAL_PUBLISHED
--
-- Mirrors NOTIFICATION_TYPES in packages/constants/src/notifications.ts. Optional and immediate-only
-- like ASSIGNMENT_PUBLISHED (000215): left out of ck_notification_preferences_mandatory_enabled and
-- ck_notification_preferences_digest_eligible (000083). Never emailed.
--
-- ## 2. app.materials.published_at and trg_materials_published
--
-- A BEFORE UPDATE OF ingest_status trigger that fires when a row turns `ready` with published_at
-- still NULL: it stamps published_at and writes one `material.published` outbox event, in the same
-- transaction as the status change. published_at is what makes it once: a re-staged material comes
-- back to `ready` with the stamp already set, so the trigger's WHEN clause does not match. A material
-- that fails or is quarantined never reaches `ready`, so never publishes; one retried after a failure
-- publishes when the retry makes it ready. Rows inserted (rather than moved) into `ready` -- only
-- seeds and tests do that -- publish nothing.
--
-- Materials that already exist are stamped so that none of them is announced as new: every one that
-- is `ready`, and every one in `queued` or `processing`, which is either a re-staged ready material
-- or an upload caught mid-ingestion by this deploy (a missed notice is safer than telling a class
-- about an old file). Uploads still `uploaded` or `scanning`, and `failed` ones a teacher may retry,
-- have never been visible and stay unstamped. Per-school loop, as in 000227: tenant_isolation is
-- FORCED on app.materials.
--
-- The workers' outbox notify consumer (apps/workers/src/queues/notifications/school-events.ts) turns
-- the event into MATERIAL_PUBLISHED inbox rows for the class's active students, and the push consumer
-- sends those to their phones.
--
-- ## 3. The notify consumer's index and discovery predicate gain material.published
--
-- idx_outbox_events_school_notify_pending and app.outbox_pending_school_ids('notify') (000216) list
-- the event names the consumer claims; NOTIFY_EVENT_NAMES in school-events.ts must match both.
--
-- transaction=off for the same reason as 000152 and 000215: PostgreSQL forbids using a new enum value
-- in the transaction that added it (nothing below uses it). Every statement is re-runnable.

SET ROLE studafy_admin;
SET lock_timeout = '5s';

-- 1 -------------------------------------------------------------------------------------------------

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'MATERIAL_PUBLISHED';

-- 2 -------------------------------------------------------------------------------------------------

ALTER TABLE app.materials ADD COLUMN IF NOT EXISTS published_at timestamptz;

COMMENT ON COLUMN app.materials.published_at IS
  'When the material first became ready, i.e. visible to the class''s students; set once by '
  'trg_materials_published, which raises material.published at that moment (000228). NULL = never '
  'published yet.';

DO $backfill$
DECLARE
  target_school_id uuid;
BEGIN
  FOR target_school_id IN SELECT id FROM app.schools LOOP
    PERFORM set_config('app.school_id', target_school_id::text, true);

    UPDATE app.materials AS m
    SET published_at = COALESCE(m.ingested_at, m.updated_at)
    WHERE m.school_id = target_school_id
      AND m.published_at IS NULL
      AND m.ingest_status IN (
        'ready'::app.material_ingest_status,
        'queued'::app.material_ingest_status,
        'processing'::app.material_ingest_status
      );
  END LOOP;

  PERFORM set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
END
$backfill$;

-- SECURITY INVOKER: the outbox row is written as whoever moved the material, under the tenant
-- context that update already ran in, so tenant_isolation on app.outbox_events checks it exactly as
-- it checks an emit() from the same transaction.
CREATE OR REPLACE FUNCTION app.publish_material()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.published_at := CURRENT_TIMESTAMP;

  -- Shape must match eventPayloadSchemas[MATERIAL_PUBLISHED] in apps/api/src/lib/events/schemas.ts.
  INSERT INTO app.outbox_events (school_id, event_name, payload)
  VALUES (
    NEW.school_id,
    'material.published',
    pg_catalog.jsonb_build_object('materialId', NEW.id, 'classId', NEW.class_id)
  );

  RETURN NEW;
END
$function$;

ALTER FUNCTION app.publish_material() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.publish_material() FROM PUBLIC, studafy_app;

COMMENT ON FUNCTION app.publish_material() IS
  'trg_materials_published: stamps app.materials.published_at and raises material.published the first time a material becomes ready (000228).';

DROP TRIGGER IF EXISTS trg_materials_published ON app.materials;

CREATE TRIGGER trg_materials_published
BEFORE UPDATE OF ingest_status ON app.materials
FOR EACH ROW
WHEN (
  NEW.ingest_status = 'ready'::app.material_ingest_status
  AND OLD.ingest_status IS DISTINCT FROM 'ready'::app.material_ingest_status
  AND NEW.published_at IS NULL
)
EXECUTE FUNCTION app.publish_material();

-- 3 -------------------------------------------------------------------------------------------------

DROP INDEX IF EXISTS app.idx_outbox_events_school_notify_pending;

CREATE INDEX idx_outbox_events_school_notify_pending
  ON app.outbox_events (school_id, id)
  WHERE notify_dispatched_at IS NULL
    AND event_name IN (
      'assignment.published',
      'submission.graded',
      'attendance.sessionSubmitted',
      'material.published'
    );

CREATE OR REPLACE FUNCTION app.outbox_pending_school_ids(p_consumer text)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  previous_school text := pg_catalog.current_setting('app.school_id', true);
  candidate uuid;
  pending boolean;
BEGIN
  IF p_consumer IS NULL OR p_consumer NOT IN ('relay', 'email', 'entitlement', 'notify', 'push') THEN
    RAISE EXCEPTION 'unknown outbox consumer %', p_consumer USING ERRCODE = '22023';
  END IF;

  FOR candidate IN SELECT school.id FROM app.schools AS school ORDER BY school.id LOOP
    PERFORM pg_catalog.set_config('app.school_id', candidate::text, true);

    IF p_consumer = 'relay' THEN
      -- idx_outbox_events_school_unrelayed (000022)
      pending := EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate AND event.relayed_at IS NULL
      );
    ELSIF p_consumer = 'email' THEN
      -- idx_outbox_events_school_email_claim (000199)
      pending := EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate
          AND event.email_dispatched_at IS NULL
          AND event.event_name IN (
            'invitation.sent',
            'school.verificationEmailSent',
            'digest.sent',
            'notification.digestSent',
            'subscription.dunningSent',
            'subscription.seatDriftReported',
            'aiSubscription.paused',
            'aiSubscription.resumed',
            'account.deletionRequested',
            'account.deleted',
            'aiSubscription.purchaseConfirmed'
          )
          AND (event.email_next_attempt_at IS NULL
               OR event.email_next_attempt_at <= CURRENT_TIMESTAMP)
      );
    ELSIF p_consumer = 'notify' THEN
      -- idx_outbox_events_school_notify_pending (000228)
      pending := EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate
          AND event.notify_dispatched_at IS NULL
          AND event.event_name IN (
            'assignment.published',
            'submission.graded',
            'attendance.sessionSubmitted',
            'material.published'
          )
      );
    ELSIF p_consumer = 'push' THEN
      -- idx_notifications_push_pending (000216)
      pending := EXISTS (
        SELECT 1 FROM app.notifications AS notification
        WHERE notification.school_id = candidate
          AND notification.push_dispatched_at IS NULL
      );
    ELSE
      -- idx_outbox_events_school_entitlement_pending (000080) and
      -- idx_outbox_events_school_user_entitlement_pending (000162)
      pending := EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate
          AND event.entitlement_applied_at IS NULL
          AND event.event_name IN ('subscription.statusChanged', 'aiSubscription.statusChanged')
      ) OR EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate
          AND event.entitlement_applied_at IS NULL
          AND event.event_name = 'userEntitlement.changed'
      );
    END IF;

    IF pending THEN
      RETURN NEXT candidate;
    END IF;
  END LOOP;

  PERFORM pg_catalog.set_config('app.school_id', COALESCE(previous_school, ''), true);
  RETURN;
END
$function$;

RESET lock_timeout;
RESET ROLE;
