-- Establishes the least-privilege PostgreSQL role and grant model for Studafy.
--
-- Roles (both NOLOGIN privilege/group roles; deployment provisions the login roles that receive
-- membership externally, so no password is ever written here):
--   studafy_admin  owns the application schema and its future objects; used by migrations and
--                  controlled maintenance. Its power comes from schema ownership, not role
--                  attributes, so it stays NOCREATEDB/NOCREATEROLE/NOSUPERUSER.
--   studafy_app    application runtime role; receives only justified CRUD grants and never owns an
--                  object, so it can never bypass Row-Level Security.
--
-- Future migrations that create application objects must run `SET ROLE studafy_admin;` first, so
-- the objects are owned by studafy_admin and the default privileges configured below apply to them.
--
-- This migration is transactional (the default) and safely repeatable: roles are cluster-global and
-- guarded against re-creation, while the schema, grants, and default privileges are per-database and
-- re-asserted idempotently. It refuses to proceed if either role pre-exists with an unsafe attribute.

-- 1. Roles: create if missing, otherwise normalise attributes to the safe baseline.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studafy_admin') THEN
    CREATE ROLE studafy_admin
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE studafy_admin
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studafy_app') THEN
    CREATE ROLE studafy_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE studafy_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- 2. Fail loudly rather than silently accept an insecure pre-existing role configuration.
DO $$
DECLARE
  role_row record;
BEGIN
  FOR role_row IN
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
    FROM pg_roles
    WHERE rolname IN ('studafy_app', 'studafy_admin')
  LOOP
    IF role_row.rolsuper
       OR role_row.rolcreatedb
       OR role_row.rolcreaterole
       OR role_row.rolreplication
       OR role_row.rolbypassrls
       OR role_row.rolcanlogin THEN
      RAISE EXCEPTION
        'Role % has an unsafe attribute (super=%, createdb=%, createrole=%, replication=%, bypassrls=%, login=%); refusing to proceed',
        role_row.rolname, role_row.rolsuper, role_row.rolcreatedb, role_row.rolcreaterole,
        role_row.rolreplication, role_row.rolbypassrls, role_row.rolcanlogin;
    END IF;
  END LOOP;
END
$$;

-- 3. Application schema owned by the administrative role. IF NOT EXISTS skips an existing schema, so
--    ownership is re-asserted explicitly to keep the owner correct on reruns.
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION studafy_admin;
ALTER SCHEMA app OWNER TO studafy_admin;

-- 4. Database-level hardening: remove the PUBLIC defaults and grant CONNECT only to the two roles.
--    Scoped to the current database via format() because the database name is environment-specific.
DO $$
DECLARE
  db_name text := current_database();
BEGIN
  EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', db_name);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO studafy_admin', db_name);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO studafy_app', db_name);
END
$$;

-- 5. Public schema hardening. PostgreSQL 16 already withholds CREATE on public from PUBLIC; this is
--    explicit defense in depth and is a no-op on a compliant cluster.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 6. Schema usage grants. studafy_admin owns app (implicitly all privileges); the grant is explicit
--    for clarity. studafy_app receives USAGE only -- never CREATE.
GRANT USAGE, CREATE ON SCHEMA app TO studafy_admin;
GRANT USAGE ON SCHEMA app TO studafy_app;

-- 7. Secure default privileges for objects that studafy_admin creates in app. These apply only to
--    future objects created by studafy_admin in this schema -- default privileges are scoped by
--    creating role, schema, and object type, never globally.
ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO studafy_app;

-- Sequence USAGE + SELECT cover nextval()/currval() for identity and serial columns. UPDATE
-- (setval) is intentionally withheld -- the application never rewinds a sequence.
ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO studafy_app;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Revoke it so function access is
-- an explicit, per-function decision in a future migration -- studafy_app receives no EXECUTE here.
-- This REVOKE is deliberately NOT scoped with IN SCHEMA: per-schema default privileges can only ADD
-- to the built-in global default, never remove from it, so revoking PUBLIC's built-in EXECUTE must be
-- done at the role's global level. It still only affects functions created by studafy_admin.
ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
