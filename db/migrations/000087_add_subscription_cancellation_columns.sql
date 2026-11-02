-- ST-137: Cancellation and retention-state columns for the school billing portal.
--
-- Cancellation initiated from the portal is end-of-period, not immediate: the admin schedules it,
-- Stripe keeps billing (and access stays live) through `current_period_end`, and the existing
-- webhook-driven state machine (packages/billing/src/state-machine.ts) is what eventually moves
-- `app.subscriptions.status` to `canceled` when Stripe sends `customer.subscription.deleted` at
-- period end. These columns record the *intent* and its context in the meantime; they never move
-- `status` themselves, which is why they need no new entry in the transition table.
--
-- `retention_state` tracks whether a save-the-customer offer was shown during the cancellation flow
-- and what came of it. It is a fact about the cancellation conversation, not about billing, so it
-- lives beside `cancellation_reason` rather than in `app.billing_events`.

SET LOCAL ROLE studafy_admin;

CREATE TYPE app.subscription_retention_state AS ENUM ('none', 'offer_shown', 'retained');

ALTER TABLE app.subscriptions
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN cancellation_requested_at timestamptz,
  ADD COLUMN cancellation_reason text,
  ADD COLUMN retention_state app.subscription_retention_state NOT NULL DEFAULT 'none';

RESET ROLE;
