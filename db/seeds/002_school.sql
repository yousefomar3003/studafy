-- Seed demo school and its subscription.
-- School is a global table (no RLS). Subscription is tenant-scoped.
-- After inserting the school, sets app.school_id for all subsequent seed files.

SET LOCAL ROLE studafy_admin;

-- Demo school
INSERT INTO app.schools (slug, name, status, country_id, default_currency_id)
SELECT
  'demo-academy',
  'Demo Academy',
  'active',
  c.id,
  cur.id
FROM app.countries c
CROSS JOIN app.currencies cur
WHERE c.alpha2_code = 'US' AND cur.code = 'USD'
ON CONFLICT (slug) DO NOTHING;

-- Set tenant context for subsequent seed files.
-- The school must exist before this runs.
SELECT set_config(
  'app.school_id',
  (SELECT id::text FROM app.schools WHERE slug = 'demo-academy'),
  false
);

-- School subscription on the starter plan
INSERT INTO app.subscriptions (school_id, plan_id, status, current_period_start, current_period_end)
SELECT
  current_setting('app.school_id')::uuid,
  p.id,
  'active',
  '2026-01-01 00:00:00+00'::timestamptz,
  '2027-01-01 00:00:00+00'::timestamptz
FROM app.plans p
WHERE p.code = 'starter'
ON CONFLICT (school_id) DO NOTHING;

-- Return school id so the runner can capture it
SELECT id FROM app.schools WHERE slug = 'demo-academy';
