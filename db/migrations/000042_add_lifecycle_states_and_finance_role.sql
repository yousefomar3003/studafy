-- ST-092: Add lifecycle subscription states and FINANCE role.
--
-- Extends the subscription_status enum with grace_period and closed values
-- for the tenant lifecycle state machine (SAD §11). Adds FINANCE role for
-- billing-restricted access during suspended tenant state.

-- 1. Extend subscription_status enum with lifecycle states.
--    grace_period: payment grace window after trial/active expiration.
--    closed: terminal state — tenant fully locked.
ALTER TYPE app.subscription_status ADD VALUE IF NOT EXISTS 'grace_period';
ALTER TYPE app.subscription_status ADD VALUE IF NOT EXISTS 'closed';

-- 2. Add FINANCE role for billing-scoped read access during suspension.
ALTER TYPE app.user_role ADD VALUE IF NOT EXISTS 'FINANCE';
