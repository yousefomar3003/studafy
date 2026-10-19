-- Studafy is free for schools: no school pays for a plan any more, and the only paid products are
-- the per-student add-ons (the AI add-on, bought on the web through Tap/Stripe or in the Android
-- app through Google Play). Every school is put on a "free" plan that is active and never ends.
--
-- A school still has one app.subscriptions row: the AI add-on, the tenant-lifecycle middleware and
-- the entitlement resolver all read the school's status from it. A school billed through a payment
-- provider (a Stripe subscription or a saved Tap card) is left alone, so nothing a provider owns is
-- rewritten under it. Closed and canceled schools are left alone too: reopening one is a decision,
-- not a data fix.

SET ROLE studafy_admin;

INSERT INTO app.plans (code, display_name, description, is_active)
VALUES ('free', 'Free', 'Studafy is free for schools.', true)
ON CONFLICT (code) DO UPDATE SET is_active = true, updated_at = CURRENT_TIMESTAMP;

DO $free_plan$
DECLARE
  tenant_id uuid;
  free_plan_id uuid;
BEGIN
  SELECT id INTO free_plan_id FROM app.plans WHERE code = 'free';

  -- app.subscriptions FORCEs RLS; update one school at a time under its own tenant context
  -- instead of weakening RLS for the migration (same approach as 000023).
  FOR tenant_id IN SELECT id FROM app.schools ORDER BY id LOOP
    PERFORM pg_catalog.set_config('app.school_id', tenant_id::text, true);

    UPDATE app.subscriptions
    SET plan_id = free_plan_id,
        status = 'active',
        trial_expires_at = NULL,
        current_period_end = '9999-12-31T00:00:00Z',
        cancel_at_period_end = false,
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = tenant_id
      AND status IN ('trialing', 'active', 'past_due', 'grace_period')
      AND stripe_subscription_id IS NULL
      AND tap_card_id IS NULL;
  END LOOP;

  PERFORM pg_catalog.set_config('app.school_id', '', true);
END
$free_plan$;

RESET ROLE;
