-- One-time Supabase project setup. Run as the project's `postgres` login BEFORE the first
-- `db-migrate migrate`, on a fresh project. Idempotent; safe to re-run.
--
--   psql "host=<pooler-host> port=5432 dbname=postgres user=postgres.<project-ref> \
--         sslmode=verify-full sslrootcert=<supabase-ca.crt>" -v ON_ERROR_STOP=1 \
--        -f db/providers/supabase/bootstrap.sql
--
-- Supabase's `postgres` login is CREATEROLE but not a superuser. The migrations were written for a
-- superuser-equivalent migration login (local, CI, RDS), so three provider defaults are adjusted
-- here instead of forking the migration chain. Verified against Supabase Postgres 17.

-- 1. pg_stat_statements is preinstalled in the `extensions` schema; migration 000003 locks it down
--    as `public.pg_stat_statements`, the documented convention (docs/database/extensions.md).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_stat_statements' AND n.nspname <> 'public'
  ) THEN
    ALTER EXTENSION pg_stat_statements SET SCHEMA public;
  END IF;
END
$$;

-- 2. Since PostgreSQL 16 a CREATEROLE login that creates a role holds only ADMIN on it, not SET, so
--    migration 000002 fails at `ALTER SCHEMA app OWNER TO studafy_admin` ("must be able to SET
--    ROLE"). Restore the pre-16 behaviour for this login only. Role-level settings apply to NEW
--    sessions: the Supabase pooler reuses warm backends, so if 000002 still fails with that error,
--    wait for the pooler to recycle its connections (or run from an IPv6 host on the direct port).
ALTER ROLE postgres SET createrole_self_grant = 'set, inherit';

-- 3. Migration 000002 revokes CONNECT/TEMPORARY on the database from PUBLIC. Supabase's own
--    service roles rely on that default -- notably `pgbouncer`, which the pooler uses to look up
--    passwords, so every pooled login starts failing with EAUTHQUERY. Grant it back to each
--    Supabase-owned role by name; explicit grants survive 000002's REVOKE FROM PUBLIC. Studafy
--    objects live in schema `app`, which none of these roles is granted.
DO $$
DECLARE
  service_role text;
BEGIN
  FOR service_role IN
    SELECT rolname FROM pg_roles
    WHERE rolname IN (
      'pgbouncer', 'authenticator', 'anon', 'authenticated', 'service_role', 'dashboard_user',
      'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'supabase_realtime_admin',
      'supabase_replication_admin', 'supabase_read_only_user', 'supabase_etl_admin'
    )
  LOOP
    EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', current_database(), service_role);
  END LOOP;
END
$$;
