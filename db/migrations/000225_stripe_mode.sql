-- Which Stripe account mode -- live or Sandbox (test) -- a stored Stripe id belongs to.
--
-- Production can run on Stripe Sandbox keys while the product is tested, and switch back to live
-- keys later (docs/billing/stripe-modes.md). A Stripe id from one mode does not exist in the other,
-- so the API must know which mode each stored id came from instead of sending a live customer or
-- subscription id to the Sandbox (or the reverse):
--
--   app.schools.stripe_customer_livemode       -- mode of stripe_customer_id
--   app.storage_subscriptions.stripe_livemode  -- mode of stripe_subscription_id
--
-- NULL means "not known yet": every id stored before this migration. The API settles it the first
-- time it needs the id (asking Stripe whether the current key can see it) and records the answer;
-- the webhook pipeline records it from the event for every new storage purchase.

SET ROLE studafy_admin;

ALTER TABLE app.schools
  ADD COLUMN stripe_customer_livemode boolean;

COMMENT ON COLUMN app.schools.stripe_customer_livemode IS
  'Stripe mode of stripe_customer_id: true live, false Sandbox, NULL not yet known (000225).';

ALTER TABLE app.storage_subscriptions
  ADD COLUMN stripe_livemode boolean;

COMMENT ON COLUMN app.storage_subscriptions.stripe_livemode IS
  'Stripe mode of stripe_subscription_id: true live, false Sandbox, NULL not yet known (000225).';

RESET ROLE;
