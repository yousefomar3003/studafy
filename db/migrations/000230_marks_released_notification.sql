-- studafy:migration transaction=off
--
-- Tell the student and their parents when marks are released.
--
-- 000229 lets leadership release one assessment's marks on its own; 000173 already released a
-- whole period's marks once its mark sheet is approved. Neither told anybody: a family found out by
-- opening the marks screen. Now each approval raises one `marks.released` outbox event in the
-- approval's transaction (apps/api/src/modules/grading/marks-service.ts), and the workers' outbox
-- notify consumer (apps/workers/src/queues/notifications/school-events.ts) turns it into
-- MARKS_RELEASED inbox rows for the section's students with a released mark in it and their linked
-- parents; the push consumer sends those to their phones (push preferences and quiet hours apply).
--
-- ## 1. app.notification_type gains MARKS_RELEASED
--
-- Mirrors NOTIFICATION_TYPES in packages/constants/src/notifications.ts. Optional and immediate-only
-- like ASSIGNMENT_GRADED (000215): left out of ck_notification_preferences_mandatory_enabled and
-- ck_notification_preferences_digest_eligible (000083). Never emailed.
--
-- ## 2. The notify consumer's index and discovery predicate gain marks.released
--
-- idx_outbox_events_school_notify_pending and app.outbox_pending_school_ids('notify') (000228) list
-- the event names the consumer claims; NOTIFY_EVENT_NAMES in school-events.ts must match both.
--
-- transaction=off for the same reason as 000215 and 000228: PostgreSQL forbids using a new enum value
-- in the transaction that added it (nothing below uses it). Every statement is re-runnable.

SET ROLE studafy_admin;
SET lock_timeout = '5s';

-- 1 -------------------------------------------------------------------------------------------------

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'MARKS_RELEASED';

-- 2 -------------------------------------------------------------------------------------------------

DROP INDEX IF EXISTS app.idx_outbox_events_school_notify_pending;

CREATE INDEX idx_outbox_events_school_notify_pending
  ON app.outbox_events (school_id, id)
  WHERE notify_dispatched_at IS NULL
    AND event_name IN (
      'assignment.published',
      'submission.graded',
      'attendance.sessionSubmitted',
      'material.published',
      'marks.released'
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
      -- idx_outbox_events_school_notify_pending (000230)
      pending := EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate
          AND event.notify_dispatched_at IS NULL
          AND event.event_name IN (
            'assignment.published',
            'submission.graded',
            'attendance.sessionSubmitted',
            'material.published',
            'marks.released'
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
