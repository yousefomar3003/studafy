-- QA-015: system transactions run as studafy_system, a role that owns nothing.
--
-- withSystemTx (API) and withSystemTenantTx (workers) used SET LOCAL ROLE studafy_admin, the owner of
-- every table in app. FORCE ROW LEVEL SECURITY binds an owner's queries, but not its DDL: an owner
-- can ALTER TABLE ... NO FORCE / DISABLE ROW LEVEL SECURITY, DROP POLICY, DETACH a partition, or
-- TRUNCATE app.audit_logs (TRUNCATE ignores RLS and the row-level append-only trigger). Any SQL that
-- reached a system transaction could switch isolation off and erase the record of having done so.
--
-- studafy_system gets what the owner's *queries* had, and nothing its ownership gave:
--   * DML on every table and USAGE on every sequence and type in app, EXECUTE on every function;
--     the audit log keeps its append-only shape (SELECT, INSERT);
--   * membership in each policy that names studafy_admin, so it sees exactly the rows the owner
--     saw (every other policy applies to PUBLIC and already covers it);
--   * the same default privileges for objects studafy_admin creates later.
-- studafy_admin stays the migration and partition-maintenance role.
--
-- Separately, the audit log refuses TRUNCATE from anyone, owner included: a statement-level trigger
-- on the parent and on every partition (a parent's TRUNCATE trigger does not fire for a partition
-- truncated by name), and app.create_audit_log_partitions adds it to each new partition.
--
-- Deployment: every login that may SET ROLE studafy_admin is granted studafy_system the same way
-- (INHERIT FALSE, SET TRUE), so the release that starts using the role works on first boot. Removing
-- studafy_admin from the API's runtime login is a follow-up for whoever owns the database logins
-- (docs/runbooks/security/runtime-db-role.md).

-- 1. The role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studafy_system') THEN
    CREATE ROLE studafy_system
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE studafy_system
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO studafy_system', current_database());
END
$$;

-- Logins that could become the owner may become the system role, so the switch needs no new
-- provisioning step. Membership only: INHERIT FALSE keeps the login itself privilege-free.
DO $$
DECLARE
  member_name text;
BEGIN
  FOR member_name IN
    SELECT m.rolname
    FROM pg_auth_members AS am
    JOIN pg_roles AS m ON m.oid = am.member
    WHERE am.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'studafy_admin')
      AND am.set_option
      AND m.rolname NOT IN ('studafy_system', 'studafy_app')
  LOOP
    EXECUTE format('GRANT studafy_system TO %I WITH INHERIT FALSE, SET TRUE', member_name);
  END LOOP;
END
$$;

SET ROLE studafy_admin;

-- 2. Privileges on what exists now.
GRANT USAGE ON SCHEMA app TO studafy_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO studafy_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO studafy_system;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO studafy_system;

DO $$
DECLARE
  type_name text;
BEGIN
  FOR type_name IN
    SELECT t.typname
    FROM pg_type AS t
    JOIN pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = 'app' AND t.typtype IN ('e', 'd') AND t.typelem = 0
  LOOP
    EXECUTE format('GRANT USAGE ON TYPE app.%I TO studafy_system', type_name);
  END LOOP;
END
$$;

-- The audit log is append-only for every runtime role, parent and partitions alike.
DO $$
DECLARE
  relation regclass;
BEGIN
  FOR relation IN
    SELECT 'app.audit_logs'::regclass
    UNION ALL
    SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'app.audit_logs'::regclass
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM studafy_system', relation);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %s TO studafy_system', relation);
  END LOOP;
END
$$;

-- 3. The same for what studafy_admin creates later.
ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO studafy_system;
ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO studafy_system;
ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO studafy_system;
ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin IN SCHEMA app
  GRANT USAGE ON TYPES TO studafy_system;

-- 4. Every policy that names the owner names the system role too.
DO $$
DECLARE
  policy record;
BEGIN
  FOR policy IN
    SELECT tablename, policyname, roles
    FROM pg_policies
    WHERE schemaname = 'app' AND 'studafy_admin' = ANY(roles) AND NOT 'studafy_system' = ANY(roles)
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON app.%I TO %s',
      policy.policyname,
      policy.tablename,
      (SELECT string_agg(quote_ident(r), ', ') FROM unnest(policy.roles || 'studafy_system'::name) AS r)
    );
  END LOOP;
END
$$;

-- 5. No TRUNCATE of the audit log, by anyone.
CREATE FUNCTION app.reject_audit_log_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'app.audit_logs is append-only; TRUNCATE of % is not permitted', TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$function$;

REVOKE ALL ON FUNCTION app.reject_audit_log_truncate() FROM PUBLIC, studafy_app, studafy_system;

DO $$
DECLARE
  relation regclass;
BEGIN
  FOR relation IN
    SELECT 'app.audit_logs'::regclass
    UNION ALL
    SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'app.audit_logs'::regclass
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_audit_logs_no_truncate BEFORE TRUNCATE ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_log_truncate()',
      relation
    );
  END LOOP;
END
$$;

-- New partitions: the same body as 000018, plus the system role's append-only grants and the
-- TRUNCATE guard.
CREATE OR REPLACE FUNCTION app.create_audit_log_partitions(target_month date)
RETURNS text[]
LANGUAGE plpgsql
SET search_path = pg_catalog
SET "TimeZone" = 'UTC'
AS $function$
DECLARE
  month_start timestamptz;
  month_end timestamptz;
  partition_name text;
  created text[] := ARRAY[]::text[];
  existing_oid oid;
  existing_kind "char";
  existing_parent oid;
  existing_bounds text;
  expected_bounds text;
BEGIN
  IF target_month IS NULL THEN
    RAISE EXCEPTION 'target month must not be null' USING ERRCODE = '22023';
  END IF;

  month_start := pg_catalog.date_trunc('month', target_month::timestamptz);
  month_end := month_start + INTERVAL '1 month';
  expected_bounds := pg_catalog.format('FOR VALUES FROM (%L) TO (%L)', month_start, month_end);

  partition_name := pg_catalog.format(
    'audit_logs_y%sm%s',
    pg_catalog.to_char(month_start, 'YYYY'),
    pg_catalog.to_char(month_start, 'MM')
  );

  SELECT c.oid, c.relkind, i.inhparent
  INTO existing_oid, existing_kind, existing_parent
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_inherits AS i ON i.inhrelid = c.oid
  WHERE n.nspname = 'app' AND c.relname = partition_name;

  IF existing_oid IS NOT NULL THEN
    IF existing_kind <> 'r'
       OR existing_parent IS DISTINCT FROM pg_catalog.to_regclass('app.audit_logs')::oid THEN
      RAISE EXCEPTION 'app.% already exists and is not a partition of app.audit_logs', partition_name
        USING ERRCODE = '42P07';
    END IF;

    SELECT pg_catalog.pg_get_expr(c.relpartbound, c.oid)
    INTO existing_bounds
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = existing_oid;

    IF pg_catalog.regexp_replace(existing_bounds, '[[:space:]]', '', 'g')
       <> pg_catalog.regexp_replace(expected_bounds, '[[:space:]]', '', 'g') THEN
      RAISE EXCEPTION
        'existing partition app.% has bounds % but % were requested; refusing to alter it',
        partition_name, existing_bounds, expected_bounds
        USING ERRCODE = '42P17';
    END IF;

    RETURN created;
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE TABLE app.%I PARTITION OF app.audit_logs FOR VALUES FROM (%L) TO (%L)',
    partition_name, month_start, month_end
  );
  -- The append-only grants, restated per partition: default privileges have already granted both
  -- runtime roles UPDATE and DELETE on this brand-new table.
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE app.%I FROM PUBLIC', partition_name);
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE app.%I FROM studafy_app', partition_name);
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE app.%I FROM studafy_system', partition_name);
  EXECUTE pg_catalog.format(
    'GRANT SELECT, INSERT ON TABLE app.%I TO studafy_app, studafy_system',
    partition_name
  );
  -- A partition truncated by name does not fire the parent's TRUNCATE trigger.
  EXECUTE pg_catalog.format(
    'CREATE TRIGGER trg_audit_logs_no_truncate BEFORE TRUNCATE ON app.%I '
    'FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_log_truncate()',
    partition_name
  );
  -- A partition is directly nameable and does not inherit the parent's policy, so it gets its own
  -- ENABLE + FORCE + canonical tenant_isolation here.
  PERFORM app.apply_tenant_isolation('app', partition_name);

  created := created || partition_name;

  RETURN created;
END
$function$;

RESET ROLE;
