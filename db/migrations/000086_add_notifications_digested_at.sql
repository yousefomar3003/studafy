-- Daily notification digest job. Adds the one thing app.notifications is missing to support it:
-- a marker for "already folded into an email digest", the same role email_dispatched_at plays on
-- app.outbox_events for the email dispatcher (000077) and the parent digest producer
-- (apps/workers/.../email/digest-producer.ts).
--
-- This is deliberately a column on app.notifications, not a new claim table. The in-app inbox row
-- already carries the rendered title/body for whatever notification_type produced it, and the
-- digest job (apps/workers/.../email/notification-digest-producer.ts) reads that row directly for
-- any user who has set notification_preferences.digest = true on the email channel for that type
-- (000083) -- regardless of which dispatcher wrote it. NULL means "not yet digested", the same
-- absent-marker-means-pending convention email_dispatched_at and app.notifications itself
-- (read_at) already use.
--
-- app.notification_preferences.digest is deliberately not consulted by ATTENDANCE_ALERT rows here,
-- even though it is digest_eligible: that type already has its own dedicated parent-facing digest
-- (digest-producer.ts, sourced from attendance.alertRaised/fee.installmentOverdue outbox events
-- directly, unconditional on this preference). Folding it into this column too would let the same
-- alert be digested twice by two independent jobs. The notification-digest-producer's own source
-- type list is what actually excludes it; this migration just adds the column both could in
-- principle share.

SET LOCAL ROLE studafy_admin;

ALTER TABLE app.notifications
  ADD COLUMN digested_at timestamptz,
  ADD CONSTRAINT ck_notifications_digested_at CHECK (digested_at IS NULL OR digested_at >= created_at);

-- The digest job's claim query: undigested rows of a handful of eligible types, across every
-- school. Partial on the same predicate the claim filters by, so the backlog it scans is
-- proportional to what is actually pending rather than to the whole inbox history.
CREATE INDEX idx_notifications_digest_pending
  ON app.notifications (school_id, notification_type, user_id, created_at)
  WHERE digested_at IS NULL;

RESET ROLE;
