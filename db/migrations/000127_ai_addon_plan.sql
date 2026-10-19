-- The per-student AI add-on as a catalog product, so the website can offer it without being handed a
-- price id from elsewhere: GET /api/subscriptions/ai/offer reads the active price of the plan whose
-- code is `ai_addon`. No price is created here -- the amount is a business decision, added (and
-- synced to the payment provider with POST /api/admin/subscriptions/sync-prices) when it is made.
-- Until then the offer has no price and the website says the add-on is not available yet.

SET ROLE studafy_admin;

INSERT INTO app.plans (code, display_name, description, is_active)
VALUES ('ai_addon', 'Studafy AI', 'The AI study assistant, per student.', true)
ON CONFLICT (code) DO NOTHING;

RESET ROLE;
