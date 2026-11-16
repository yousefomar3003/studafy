-- The AI add-on's price: USD 5.99 a month per student, the amount the product owner set
-- (2026-11-14). 000146 created the ai_addon plan without a price on purpose; until this row exists
-- GET /api/subscriptions/ai/offer has no price and the website says the add-on is not available.
--
-- The phone apps sell the same add-on through Apple and Google at the same amount (products
-- studafy_ai_monthly and _2.._4); those prices live in the stores, not here.
--
-- A USD monthly row may already exist (added by hand before this migration). It is set to this
-- amount only while it has no Stripe price: a Stripe price's amount can never change, so a row
-- that was already synced is left alone. Chargeable through Stripe once
-- POST /api/admin/subscriptions/sync-prices ("Sync with Stripe") has created it there.

SET ROLE studafy_admin;

INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor, is_active)
SELECT p.id, c.id, 'monthly'::app.billing_interval, 599, true
FROM app.plans AS p
JOIN app.currencies AS c ON c.code = 'USD'
WHERE p.code = 'ai_addon'
ON CONFLICT ON CONSTRAINT uq_plan_prices_plan_currency_interval DO UPDATE
SET amount_minor = EXCLUDED.amount_minor,
    is_active = true,
    updated_at = CURRENT_TIMESTAMP
WHERE app.plan_prices.stripe_price_id IS NULL;

RESET ROLE;
