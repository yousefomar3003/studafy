-- Test-only (QA-003). NOT a migration: never run against a deployed database.
--
-- A least-privilege application login for the disposable test cluster, shaped like the production
-- runtime role QA-014 asks for: it can log in, it is not a superuser, it cannot bypass RLS, it owns
-- nothing, and it reaches data only through the explicit role switches the app already makes
-- (withTenantTx: set_config('role', 'studafy_app', true); withSystemTx: SET LOCAL ROLE
-- studafy_system; partition maintenance: SET LOCAL ROLE studafy_admin). INHERIT FALSE is the
-- point: a query that runs outside those switches has no table privileges at all, so code that
-- silently relied on the login's own rights fails loudly.
--
-- Roles are cluster-wide, so this runs once per cluster, after the migrations created
-- studafy_app, studafy_admin and studafy_system. Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'studafy_runtime') THEN
    CREATE ROLE studafy_runtime LOGIN PASSWORD 'studafy_runtime_test_only'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

GRANT studafy_app TO studafy_runtime WITH INHERIT FALSE, SET TRUE;
GRANT studafy_admin TO studafy_runtime WITH INHERIT FALSE, SET TRUE;
-- Created by migration 000240 (QA-015), which this script follows.
GRANT studafy_system TO studafy_runtime WITH INHERIT FALSE, SET TRUE;

-- Migration 000002 revokes CONNECT from PUBLIC and grants it to studafy_app/studafy_admin only; with
-- INHERIT FALSE nothing flows through, so the login needs CONNECT on each database it uses. The API
-- test harness grants it on every disposable per-test database; this covers the shared one.
GRANT CONNECT ON DATABASE postgres TO studafy_runtime;
