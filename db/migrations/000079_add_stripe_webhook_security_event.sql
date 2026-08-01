-- Extends app.security_event_type with the Stripe webhook signature-verification failure (ST-132).
--
-- A request carrying an absent or forged Stripe-Signature header is a boundary rejection of exactly
-- the kind 000028 built this table for: unauthenticated, pre-tenant, and interesting precisely
-- because it arrived. It rides the existing ST-082 alerting path -- a structured log line at ERROR
-- level plus a row through the async SecurityEventSink -- rather than a second alerting mechanism of
-- its own, so monitoring can build rules on either signal the same way it already does for
-- auth_rate_limit_block.
--
-- Separate from 000078 because a new enum value cannot be *used* in the transaction that adds it,
-- and keeping the two apart leaves each migration independently re-runnable.
--
-- Depends on 000028 (app.security_event_type enum). Mirrors 000032.

SET LOCAL ROLE studafy_admin;

ALTER TYPE app.security_event_type ADD VALUE IF NOT EXISTS 'stripe_webhook_signature_invalid';

RESET ROLE;
