-- studafy:migration transaction=off
-- The email dispatcher's claim path, narrowed to the events it actually claims.
--
-- 000077's idx_outbox_events_school_email_pending is `WHERE email_dispatched_at IS NULL`, but only
-- the email-relevant events ever get that cursor set. Every other outbox event (attendance, grades,
-- audit-driven events, entitlement changes, ...) keeps email_dispatched_at NULL forever, so that
-- index held -- and kept growing by -- every non-email row the outbox has ever written, and each
-- claim and pending-school probe walked those entries to find the few email rows. 000080 avoided
-- the same trap for the entitlement cursor by naming its events in the predicate; this does the
-- same for email.
--
-- The list must stay in step with EMAIL_EVENT_NAMES in
-- apps/workers/src/queues/notifications/email/resolve.ts: the dispatcher's claim (claim.ts) and
-- app.outbox_pending_school_ids('email') (000200) filter on a subset of it, which is what lets the
-- planner prove they imply this predicate. Adding an email event therefore needs a migration that
-- rebuilds this index; apps/workers' outbox-discovery test fails until it does.
--
-- Built concurrently (so the outbox, written inside every webhook and audited mutation, stays
-- writable) and on its own, because CREATE INDEX CONCURRENTLY cannot share a migration with other
-- statements. 000200 drops the 000077 index once this one exists.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_events_school_email_claim
  ON app.outbox_events (school_id, id)
  WHERE email_dispatched_at IS NULL
    AND event_name IN (
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
    );
