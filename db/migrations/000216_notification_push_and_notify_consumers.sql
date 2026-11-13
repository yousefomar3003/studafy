-- Notifications that actually reach people.
--
-- Until now only one producer (the grades.published dispatcher) ever sent a push; every other
-- in-app notification -- messages, announcements, fee notices, attendance alerts -- landed in the
-- inbox and nowhere else. And the everyday school events (an assignment published, a hand-in graded,
-- a child marked absent) produced no notification at all. Two workers consumers fix that, and this
-- migration gives each its pending marker and its discovery branch.
--
-- ## 1. app.notifications.push_dispatched_at -- the push consumer
--
-- Every inbox row is a push candidate; the workers' push consumer claims rows with
-- push_dispatched_at IS NULL, stamps them, and sends through FCM to the recipient's live devices
-- (respecting their push preference and quiet hours). Rows whose producer already pushed them (the
-- grades dispatcher) are inserted with it set. Existing rows are stamped with the epoch through the
-- column's initial default -- a metadata-only change, no table rewrite -- so the backlog of old inbox
-- rows is never pushed; the default is then dropped so new rows start pending.
--
-- ## 2. app.outbox_events.notify_dispatched_at -- the notify consumer
--
-- The same pending-marker shape email_dispatched_at has (000077): the notify consumer turns
-- assignment.published, submission.graded and attendance.sessionSubmitted rows into inbox rows, in
-- the same transaction that stamps the marker, so each event notifies exactly once. Existing rows
-- get the epoch for the same reason as above.
--
-- ## 3. app.outbox_pending_school_ids gains 'notify' and 'push'
--
-- One-statement pending-school discovery (000200) for the two new loops, under the same per-school
-- tenant probing.

SET LOCAL ROLE studafy_admin;
SET LOCAL lock_timeout = '5s';

-- 1 -------------------------------------------------------------------------------------------------

ALTER TABLE app.notifications
  ADD COLUMN push_dispatched_at timestamptz DEFAULT 'epoch';
ALTER TABLE app.notifications
  ALTER COLUMN push_dispatched_at DROP DEFAULT;

COMMENT ON COLUMN app.notifications.push_dispatched_at IS
  'When the push consumer handled this row (sent, or skipped by preference/quiet hours/no device). NULL = pending. The epoch marks rows that predate the push consumer.';

CREATE INDEX idx_notifications_push_pending
  ON app.notifications (school_id, created_at)
  WHERE push_dispatched_at IS NULL;

-- 2 -------------------------------------------------------------------------------------------------

ALTER TABLE app.outbox_events
  ADD COLUMN notify_dispatched_at timestamptz DEFAULT 'epoch';
ALTER TABLE app.outbox_events
  ALTER COLUMN notify_dispatched_at DROP DEFAULT;

COMMENT ON COLUMN app.outbox_events.notify_dispatched_at IS
  'When the notify consumer turned this event into inbox rows. NULL = pending (for the event names it consumes). The epoch marks rows that predate the consumer.';

CREATE INDEX idx_outbox_events_school_notify_pending
  ON app.outbox_events (school_id, id)
  WHERE notify_dispatched_at IS NULL
    AND event_name IN ('assignment.published', 'submission.graded', 'attendance.sessionSubmitted');

-- 3 -------------------------------------------------------------------------------------------------

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
      -- idx_outbox_events_school_notify_pending (this migration)
      pending := EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate
          AND event.notify_dispatched_at IS NULL
          AND event.event_name IN ('assignment.published', 'submission.graded', 'attendance.sessionSubmitted')
      );
    ELSIF p_consumer = 'push' THEN
      -- idx_notifications_push_pending (this migration)
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

COMMENT ON FUNCTION app.outbox_pending_school_ids(text) IS
  'Schools with rows pending for one polling consumer (relay | email | entitlement | notify | push), probed one tenant at a time under the canonical tenant policy.';

RESET ROLE;
