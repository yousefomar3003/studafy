-- Seed global reference data: subscription plans and per-currency pricing.
-- These are global tables (no school_id, no tenant RLS) owned by studafy_admin.
-- Idempotent: ON CONFLICT DO NOTHING on unique business keys.

SET LOCAL ROLE studafy_admin;

-- Subscription plans
INSERT INTO app.plans (code, display_name, description)
VALUES
  ('starter', 'Starter', 'Basic plan for small schools with up to 100 students'),
  ('pro', 'Pro', 'Full-featured plan for schools of any size')
ON CONFLICT (code) DO NOTHING;

-- Plan pricing: USD monthly and yearly
INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
SELECT
  p.id,
  c.id,
  interval_val.interval,
  interval_val.amount
FROM app.plans p
CROSS JOIN app.currencies c
CROSS JOIN (VALUES
  ('starter', 'monthly', 4900),
  ('starter', 'yearly', 49000),
  ('pro', 'monthly', 9900),
  ('pro', 'yearly', 99000)
) AS interval_val(plan_code, interval, amount)
WHERE p.code = interval_val.plan_code
  AND c.code = 'USD'
ON CONFLICT (plan_id, currency_id, billing_interval) DO NOTHING;
