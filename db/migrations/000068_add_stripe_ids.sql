-- Stripe billing integration columns.
--
-- Adds Stripe metadata columns to the existing subscription/plan tables so the
-- StripeAdapter can store provider-side identifiers without secondary mapping
-- tables.  Follows the same one-column-per-Stripe-ID pattern used for ERPNext
-- site configs (000038) rather than a generic key-value mapping table, because
-- every row in these tables maps to exactly one Stripe entity.
--
-- app.plans.stripe_product_id   — Stripe Product ID (prod_xxx)
-- app.plan_prices.stripe_price_id — Stripe Price ID (price_xxx)
-- app.schools.stripe_customer_id  — Stripe Customer ID (cus_xxx)
-- app.subscriptions.stripe_subscription_id — Stripe Subscription ID (sub_xxx)

SET ROLE studafy_admin;

-- Plans
ALTER TABLE app.plans
  ADD COLUMN stripe_product_id text;

ALTER TABLE app.plans
  ADD COLUMN stripe_price_id text;

ALTER TABLE app.plans
  ADD CONSTRAINT uq_plans_stripe_product_id UNIQUE (stripe_product_id);

-- Plan prices
ALTER TABLE app.plan_prices
  ADD COLUMN stripe_price_id text;

ALTER TABLE app.plan_prices
  ADD CONSTRAINT uq_plan_prices_stripe_price_id UNIQUE (stripe_price_id);

-- Schools
ALTER TABLE app.schools
  ADD COLUMN stripe_customer_id text;

ALTER TABLE app.schools
  ADD CONSTRAINT uq_schools_stripe_customer_id UNIQUE (stripe_customer_id);

-- Subscriptions
ALTER TABLE app.subscriptions
  ADD COLUMN stripe_subscription_id text;

ALTER TABLE app.subscriptions
  ADD CONSTRAINT uq_subscriptions_stripe_subscription_id UNIQUE (stripe_subscription_id);

ALTER TABLE app.subscriptions
  ADD COLUMN stripe_subscription_item_id text;

RESET ROLE;
