-- Tenant ownership is a physical invariant, not merely an RLS convention. A BYPASSRLS role or
-- temporarily disabled policy must still be unable to move a row from one school to another.

SET ROLE studafy_admin;

CREATE FUNCTION app.reject_tenant_school_id_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.school_id IS DISTINCT FROM OLD.school_id THEN
    RAISE EXCEPTION 'tenant ownership is immutable on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION app.reject_tenant_school_id_mutation() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.reject_tenant_school_id_mutation() FROM PUBLIC, studafy_app;

CREATE FUNCTION app.apply_tenant_ownership_immutability(
  target_schema name,
  target_table name
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_oid oid;
  target_kind "char";
  school_id_attnum smallint;
  mutation_function_oid oid;
BEGIN
  SELECT c.oid, c.relkind
  INTO target_oid, target_kind
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = target_schema::text
    AND c.relname = target_table::text;

  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'target table %.% does not exist', target_schema, target_table
      USING ERRCODE = '42P01';
  END IF;
  IF target_schema::text <> 'app' OR target_kind NOT IN ('r', 'p') THEN
    RAISE EXCEPTION 'tenant ownership protection requires an app table, got %.%',
      target_schema, target_table USING ERRCODE = '42809';
  END IF;

  SELECT a.attnum INTO school_id_attnum
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = target_oid
    AND a.attname = 'school_id'
    AND a.attnum > 0
    AND NOT a.attisdropped;
  IF school_id_attnum IS NULL THEN
    RAISE EXCEPTION 'tenant table %.% must contain school_id', target_schema, target_table
      USING ERRCODE = '42703';
  END IF;

  SELECT p.oid INTO mutation_function_oid
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app' AND p.proname = 'reject_tenant_school_id_mutation'
    AND p.pronargs = 0;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_catalog
    WHERE trigger_catalog.tgrelid = target_oid
      AND NOT trigger_catalog.tgisinternal
      AND trigger_catalog.tgfoid = mutation_function_oid
      AND (trigger_catalog.tgtype & 1) = 1
      AND (trigger_catalog.tgtype & 2) = 2
      AND (trigger_catalog.tgtype & 16) = 16
      AND school_id_attnum = ANY(trigger_catalog.tgattr::smallint[])
  ) THEN
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER trg_tenant_school_id_immutable '
      'BEFORE UPDATE OF school_id ON %I.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.reject_tenant_school_id_mutation()',
      target_schema,
      target_table
    );
  END IF;
END
$function$;

ALTER FUNCTION app.apply_tenant_ownership_immutability(name, name) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.apply_tenant_ownership_immutability(name, name)
FROM PUBLIC, studafy_app;
GRANT EXECUTE ON FUNCTION app.apply_tenant_ownership_immutability(name, name) TO studafy_admin;

-- Preserve the fully validated ST-034/ST-040 helper as the RLS implementation and put a narrow
-- wrapper at its public entry point. Existing ACLs follow the renamed function.
ALTER FUNCTION app.apply_tenant_isolation(name, name)
  RENAME TO apply_tenant_isolation_policy;

CREATE FUNCTION app.apply_tenant_isolation(
  target_schema name,
  target_table name
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM app.apply_tenant_isolation_policy(target_schema, target_table);
  PERFORM app.apply_tenant_ownership_immutability(target_schema, target_table);
END
$function$;

ALTER FUNCTION app.apply_tenant_isolation(name, name) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.apply_tenant_isolation(name, name) FROM PUBLIC, studafy_app;
GRANT EXECUTE ON FUNCTION app.apply_tenant_isolation(name, name) TO studafy_admin;
REVOKE ALL ON FUNCTION app.apply_tenant_isolation_policy(name, name) FROM PUBLIC, studafy_app;

-- Install one trigger on every root relation. PostgreSQL clones a partitioned parent's row trigger
-- onto existing and future leaves, so installing a second trigger directly on each leaf is avoided.
DO $retrofit$
DECLARE
  tenant_table record;
BEGIN
  FOR tenant_table IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute AS a
      ON a.attrelid = c.oid
     AND a.attname = 'school_id'
     AND a.attnum > 0
     AND NOT a.attisdropped
    WHERE n.nspname = 'app'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
    ORDER BY c.relname
  LOOP
    PERFORM app.apply_tenant_ownership_immutability(
      tenant_table.schema_name,
      tenant_table.table_name
    );
  END LOOP;
END
$retrofit$;

RESET ROLE;
