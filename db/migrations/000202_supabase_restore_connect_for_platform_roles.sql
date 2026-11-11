-- Give Supabase's own login roles back the CONNECT that 000002 takes from PUBLIC.
--
-- 000002 revokes CONNECT and TEMPORARY on the database from PUBLIC and grants CONNECT to the studafy
-- roles only, so that no login role but the ones this repository knows about can open a session.
-- On Supabase every other login role belongs to the platform: pgbouncer (the pooler's auth query,
-- which every pooled connection goes through), authenticator, supabase_auth_admin,
-- supabase_storage_admin, supabase_replication_admin and so on. They connect through exactly that
-- PUBLIC grant, so after 000002 each of them was refused ("User does not have CONNECT privilege",
-- some 18,000 times a day as they retried) until the pooler could no longer authenticate anyone and
-- the API lost the database (production, 2026-11-11; infra/fly/README.md "Where Supabase differs").
--
-- On Supabase the grant goes back to PUBLIC, Supabase's own default, rather than to the platform
-- roles one by one: the list is Supabase's, and a role it adds later would repeat the outage. This
-- does not widen what Studafy's code can do: the services log in as Supabase's `postgres` and switch
-- to studafy_app/studafy_admin per transaction, and no studafy role can log in.
--
-- Anywhere else (local Postgres, CI, RDS) there is no supabase_admin role and this does nothing, so
-- 000002's lockdown stands.

DO $$
DECLARE
  db_name text := current_database();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    RETURN;
  END IF;
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO PUBLIC', db_name);
END
$$;
