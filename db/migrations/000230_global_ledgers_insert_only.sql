-- QA-017: the runtime role may record into the global email and security ledgers, not read them.
--
-- studafy_app held SELECT (and UPDATE) on app.email_events and app.email_suppressions -- every
-- school's recipient addresses and delivery events -- and SELECT on app.security_events (client IPs
-- and user agents of rejected requests). These tables are global, so any tenant transaction could
-- read all of it. The runtime only ever INSERTs into them (the Resend webhook, the security-event
-- sink); every read is already a system transaction (platform health, retention sweeps, the email
-- dispatcher's suppression check), which runs as studafy_admin and is unaffected.
--
-- app.email_deliveries keeps its grants: it is per-school, row-level secured, and the webhook
-- updates its rows.

SET ROLE studafy_admin;

REVOKE SELECT, UPDATE ON TABLE app.email_events, app.email_suppressions FROM studafy_app;
REVOKE SELECT ON TABLE app.security_events FROM studafy_app;

RESET ROLE;
