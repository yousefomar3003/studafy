-- Extends app.security_event_type with the Tap webhook signature-verification failure (ST-298).
--
-- The Tap counterpart of 000079's stripe_webhook_signature_invalid: a webhook arriving with an
-- absent or wrong `hashstring` header. A separate value rather than a reuse of the Stripe one,
-- because an alert that says "stripe" while Tap's secret key has rotated sends whoever is paged to
-- the wrong dashboard.
--
-- Separate from 000111 because a new enum value cannot be used in the transaction that adds it.

SET LOCAL ROLE studafy_admin;

ALTER TYPE app.security_event_type ADD VALUE IF NOT EXISTS 'tap_webhook_signature_invalid';

RESET ROLE;
