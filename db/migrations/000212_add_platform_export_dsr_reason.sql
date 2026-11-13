-- studafy:migration transaction=off
--
-- Adds 'platform_export' to app.dsr_reason.
--
-- A platform export is a whole-school export bundle the Studafy platform console files for a
-- school that is still open (a support or migration request), as opposed to 'tenant_closure', the
-- export the closure sweep files for a closed school before erasing it. The two must never be
-- confused: the closure sweep treats a completed tenant export as "the closure export is done" and
-- files erasure 30 days later, so a console export filed under 'tenant_closure' would let a later
-- closure skip its own export and erase against a stale bundle. Its own reason keeps them apart.
--
-- transaction=off is required, not stylistic: PostgreSQL forbids USING a new enum value in the
-- same transaction that added it, and the migration runner wraps every transactional migration
-- in BEGIN/COMMIT. This file only ADDs the value; the CHECKs that reference it are in
-- 000213_allow_platform_export_dsr.sql. ADD VALUE IF NOT EXISTS keeps a re-run a no-op.

SET ROLE studafy_admin;

ALTER TYPE app.dsr_reason ADD VALUE IF NOT EXISTS 'platform_export';

RESET ROLE;
