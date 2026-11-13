-- Extends app.security_event_type with auth-specific anomaly counters.
--
-- Two new values track brute-force and token-reuse events that the rate limiter and session
-- service emit into app.security_events. These fire alongside the structured log entries at
-- ERROR level so monitoring can build alert rules on either signal.
--
-- Depends on 000028 (app.security_event_type enum).

SET ROLE studafy_admin;

ALTER TYPE app.security_event_type ADD VALUE IF NOT EXISTS 'auth_rate_limit_block';
ALTER TYPE app.security_event_type ADD VALUE IF NOT EXISTS 'auth_token_reuse_detected';

RESET ROLE;
