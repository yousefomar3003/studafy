-- Apply canonical tenant isolation to the school_settings table created in 000036.
--
-- The table was created without RLS because its row structure was finalized before the tenant
-- isolation helper was invoked. This migration closes the gap: ENABLE + FORCE ROW LEVEL SECURITY,
-- the tenant_isolation policy, and the immutability trigger that prevents school_id mutations.

SET ROLE studafy_admin;

SELECT app.apply_tenant_isolation('app', 'school_settings');

RESET ROLE;
