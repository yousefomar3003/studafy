-- Enables the four PostgreSQL 16 extensions Studafy depends on and secures access to them.
--
-- Extensions (installed into the public schema, the documented convention -- see
-- docs/database/extensions.md):
--   pgcrypto            cryptographic hashing / secure random bytes. gen_random_uuid() is core in
--                       PostgreSQL 13+, so pgcrypto is enabled for digest()/hmac()/gen_random_bytes(),
--                       not for UUID generation.
--   pg_trgm             trigram similarity and index operator classes for fuzzy / ILIKE search.
--   vector              pgvector types and distance operators (extension name is `vector`, not
--                       `pgvector`). On AWS RDS it is on the Postgres 16 extension allowlist.
--   pg_stat_statements  query-execution telemetry. CREATE EXTENSION succeeding does NOT make it
--                       operational: the module must be loaded via shared_preload_libraries (an
--                       infrastructure/parameter-group setting that requires a restart). This
--                       migration enables it and locks its statistics down, then WARNS -- rather than
--                       fails -- if the library is not preloaded, so the other three extensions still
--                       enable on any Postgres 16. Operational verification lives in the tests and the
--                       environment procedure, never in a bare CREATE EXTENSION.
--
-- Ownership: extensions require superuser (rds_superuser on RDS) to install and are therefore owned
-- by the migration-runner identity, never by studafy_admin (NOSUPERUSER) or studafy_app. This
-- migration deliberately does NOT `SET ROLE studafy_admin`; extension installation is an
-- administrative operation and stays with the connecting superuser.
--
-- This migration is transactional (the default) and idempotent: CREATE EXTENSION IF NOT EXISTS,
-- guarded role creation, and re-assertable REVOKE/GRANT statements.

-- 1. Depend explicitly on the ST-031 role model (000002). Fail loudly rather than silently skipping
--    the monitoring grants if the runtime role is absent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studafy_app') THEN
    RAISE EXCEPTION
      'Role studafy_app is missing; migration 000002 (database roles and grants) must run first';
  END IF;
END
$$;

-- 2. Enable the required extensions. IF NOT EXISTS keeps reruns idempotent; an unavailable extension
--    (e.g. removed from a managed-provider allowlist) raises here and fails the migration clearly.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 3. Monitoring role. NOLOGIN privilege/group role in the ST-031 mould: the login identity is
--    provisioned externally in Secrets Manager and granted membership, so no password is written
--    here. Create if missing, otherwise normalise attributes to the safe baseline.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studafy_monitor') THEN
    CREATE ROLE studafy_monitor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE studafy_monitor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- 4. Refuse to proceed if studafy_monitor pre-exists with an unsafe attribute. Monitoring reads
--    telemetry only; it must never be able to log in on its own, own objects, or bypass RLS.
DO $$
DECLARE
  role_row record;
BEGIN
  SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
    INTO role_row
  FROM pg_roles
  WHERE rolname = 'studafy_monitor';

  IF role_row.rolsuper
     OR role_row.rolcreatedb
     OR role_row.rolcreaterole
     OR role_row.rolreplication
     OR role_row.rolbypassrls
     OR role_row.rolcanlogin THEN
    RAISE EXCEPTION
      'Role studafy_monitor has an unsafe attribute (super=%, createdb=%, createrole=%, replication=%, bypassrls=%, login=%); refusing to proceed',
      role_row.rolsuper, role_row.rolcreatedb, role_row.rolcreaterole,
      role_row.rolreplication, role_row.rolbypassrls, role_row.rolcanlogin;
  END IF;
END
$$;

-- 5. Let studafy_monitor reach the database. 000002 revoked CONNECT from PUBLIC, so it is granted
--    explicitly. Scoped to the current database via format() because the name is environment-specific.
DO $$
DECLARE
  db_name text := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO studafy_monitor', db_name);
END
$$;

-- 6. Monitoring access to pg_stat_statements, and nothing wider.
--    pg_read_all_stats is the narrowest built-in role that lets a non-superuser see the full query
--    text of statements run by other roles in pg_stat_statements. pg_monitor is deliberately NOT
--    used -- it also bundles pg_read_all_settings and pg_stat_scan_tables, which monitoring here
--    does not need.
GRANT pg_read_all_stats TO studafy_monitor;

-- The pg_stat_statements extension grants SELECT on its views to PUBLIC by default, which would
-- expose call counts and timing (and, for own statements, query text) to studafy_app and every
-- other role. Revoke that and grant SELECT only to studafy_monitor. pg_stat_statements_reset() is
-- left superuser-only (its default) -- resetting telemetry is an administrative action.
REVOKE ALL ON public.pg_stat_statements FROM PUBLIC;
GRANT SELECT ON public.pg_stat_statements TO studafy_monitor;

-- pg_stat_statements_info exists from extension version 1.9+ (Postgres 16 ships 1.10). Guard it so
-- the migration is portable to any 1.x that predates the view.
DO $$
BEGIN
  IF to_regclass('public.pg_stat_statements_info') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.pg_stat_statements_info FROM PUBLIC';
    EXECUTE 'GRANT SELECT ON public.pg_stat_statements_info TO studafy_monitor';
  END IF;
END
$$;

-- 7. Honest operationality check. CREATE EXTENSION above succeeds regardless of preloading, but the
--    views only return rows when the module is loaded via shared_preload_libraries. Warn (do not
--    fail) when it is not, so this migration stays portable while signalling the infrastructure gap.
--    The environment procedure and the extension tests perform the hard, fail-closed verification.
DO $$
DECLARE
  preloaded text := current_setting('shared_preload_libraries', true);
BEGIN
  IF preloaded IS NULL OR strpos(preloaded, 'pg_stat_statements') = 0 THEN
    RAISE WARNING
      'pg_stat_statements is enabled but not in shared_preload_libraries; it is NOT collecting statistics. Add it to the parameter group and restart -- see docs/database/extensions.md.';
  END IF;
END
$$;

-- pgcrypto, pg_trgm, and vector expose only pure computational functions/types. They keep the
-- PostgreSQL default (EXECUTE/USAGE to PUBLIC); studafy_app receives no extra grant and future
-- application migrations grant per demonstrated need. No application tables and no extension-backed
-- indexes are created here -- enabling an extension does not justify an index (see extensions.md).
