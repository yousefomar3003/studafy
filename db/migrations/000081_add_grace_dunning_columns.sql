-- ST-134: Grace-period and dunning columns.
--
-- The Stripe webhooks (ST-132) already move a subscription into `grace_period` the moment the
-- provider's own dunning is exhausted; what the scheduled dunning job adds is the *time* dimension
-- the webhooks cannot express. Two facts about that window live here:
--
--   1. `grace_period_ends_at` -- when the grace window runs out and the subscription must be
--      closed. Stamped by the billing state machine in the same transaction that enters
--      `grace_period` (14 days for a school subscription, 7 for an AI add-on), and cleared the
--      moment a transition leaves `grace_period`. The scheduled job suspends on
--      `grace_period_ends_at < now`, so the deadline and the status can never disagree.
--
--   2. `dunning_email_stage` -- how far the reminder sequence has progressed, so the scheduled job
--      sends each stage of the sequence exactly once even though it runs on a coarser cadence than
--      the reminders are scheduled on.
--
-- Both are current-state facts of the row they live on, which is why they are columns on the
-- subscription tables rather than rows in app.billing_events: that log records provider events, and
-- a grace window is an outcome of them, not a new event.

SET LOCAL ROLE studafy_admin;

ALTER TABLE app.subscriptions
  ADD COLUMN grace_period_ends_at timestamptz,
  ADD COLUMN dunning_email_stage smallint NOT NULL DEFAULT 0;

ALTER TABLE app.ai_subscriptions
  ADD COLUMN grace_period_ends_at timestamptz,
  ADD COLUMN dunning_email_stage smallint NOT NULL DEFAULT 0;

-- No backfill for rows already in `grace_period`: there are none in a fresh deploy (this feature
-- is what creates them), and an UPDATE here would trip the FORCE'd tenant RLS, which keys on
-- `current_setting('app.school_id')` and matches nothing outside a tenant transaction. The sweep
-- treats a NULL deadline as "not yet measured" and leaves such a row alone rather than guessing.

RESET ROLE;
