-- ERPNext on Fly (docs/plans/erpnext-fly.md): the site agent's state on app.erpnext_site_configs.
--
-- A small agent on the ERPNext machine creates each school's Frappe site with bench (which the REST
-- API cannot do), and puts sites to sleep and wakes them so ERPNext's per-site scheduler only runs
-- for schools that use finance. It reads and reports this state through /api/internal/erpnext/*:
--
--   site_created_at           when the agent finished `bench new-site` and the site setup. NULL: the
--                             site does not exist yet (the agent's pending list).
--   scheduler_enabled         whether the site's ERPNext scheduler is on. New sites start asleep.
--   wake_requested_at         set by the API when a school with a sleeping site makes a finance
--                             request; the agent enables the scheduler and clears it.
--   last_finance_activity_at  the school's latest finance request (written at most once an hour);
--                             an awake site idle for 30 days is put back to sleep.
--
-- Columns only. RLS, grants and the tenant_isolation policy are unchanged (000038): the agent's
-- routes read across schools the way the platform console does, one school's scope at a time.
--
-- No index: every query the agent's routes run is per school (uq_erpnext_site_configs_school) or by
-- id (the primary key), and a school has at most one row.
--
-- Additive only (docs/database/migration-policy.md): three nullable columns and one with a constant
-- default, which PostgreSQL 16 adds without rewriting the table.

SET ROLE studafy_admin;

ALTER TABLE app.erpnext_site_configs
  ADD COLUMN IF NOT EXISTS site_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduler_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS wake_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_finance_activity_at timestamptz;

COMMENT ON COLUMN app.erpnext_site_configs.site_created_at IS
  'When the ERPNext site agent created the Frappe site (bench new-site + setup). NULL: not created yet.';
COMMENT ON COLUMN app.erpnext_site_configs.scheduler_enabled IS
  'Whether the site''s ERPNext scheduler is enabled. Sites start asleep; the agent wakes them on use.';
COMMENT ON COLUMN app.erpnext_site_configs.wake_requested_at IS
  'Set when a finance request finds the site asleep; cleared by the agent once the scheduler is on.';
COMMENT ON COLUMN app.erpnext_site_configs.last_finance_activity_at IS
  'The school''s latest finance request, recorded at most once an hour. Drives the 30-day sleep rule.';

RESET ROLE;
