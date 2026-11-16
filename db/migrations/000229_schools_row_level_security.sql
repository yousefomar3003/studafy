-- QA-016: app.schools is no longer readable or writable across schools from a tenant transaction.
--
-- The table holds every school's contact email, email-verification token hash, Stripe and Tap
-- customer ids, status and closure time. It had no row-level security, and studafy_app held SELECT,
-- INSERT and UPDATE (000004, 000035): any app-layer bug that let a request name another school's id
-- could read those or suspend that school. Now:
--
--   * studafy_app (tenant transactions) may SELECT and UPDATE only the armed school's own row --
--     the school's own lifecycle writes (closure, email verification, provisioning, billing
--     customer ids) all target that row, so the cross-school hole closes without moving them;
--   * studafy_admin (system transactions and SECURITY DEFINER functions such as register_school)
--     keeps full access: every platform-console write already runs there;
--   * INSERT is revoked from studafy_app (registration goes through register_school).
--
-- FORCE, so the owner is bound by the policies too and the studafy_admin policy is what admits it.

SET ROLE studafy_admin;

REVOKE INSERT ON app.schools FROM studafy_app;

ALTER TABLE app.schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.schools FORCE ROW LEVEL SECURITY;

CREATE POLICY schools_own_row
  ON app.schools
  AS PERMISSIVE
  FOR SELECT
  TO studafy_app
  USING (id = nullif(pg_catalog.current_setting('app.school_id', true), '')::uuid);

CREATE POLICY schools_own_row_update
  ON app.schools
  AS PERMISSIVE
  FOR UPDATE
  TO studafy_app
  USING (id = nullif(pg_catalog.current_setting('app.school_id', true), '')::uuid)
  WITH CHECK (id = nullif(pg_catalog.current_setting('app.school_id', true), '')::uuid);

CREATE POLICY schools_system
  ON app.schools
  AS PERMISSIVE
  FOR ALL
  TO studafy_admin
  USING (true)
  WITH CHECK (true);

RESET ROLE;
