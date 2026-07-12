-- Installs the canonical tenant Row-Level Security helper for school-owned tables.
-- The helper is administrative DDL: migrations invoke it as studafy_admin after creating and
-- indexing a normalized tenant table. Runtime roles cannot execute it.

SET ROLE studafy_admin;

CREATE OR REPLACE FUNCTION app.apply_tenant_isolation(
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
  target_owner oid;
  admin_oid oid;
  schools_oid oid;
  school_id_attnum smallint;
  school_id_type oid;
  school_id_typmod integer;
  school_id_not_null boolean;
  canonical_attnum smallint;
  canonical_type oid;
  canonical_typmod integer;
  canonical_policy record;
  canonical_policy_found boolean;
  normalized_using text;
  normalized_check text;
  expected_expression text := 'school_id=current_setting''app.school_id''::uuid';
BEGIN
  IF target_schema IS NULL OR pg_catalog.btrim(target_schema::text) = ''
     OR target_table IS NULL OR pg_catalog.btrim(target_table::text) = '' THEN
    RAISE EXCEPTION 'target schema and table names must be non-empty'
      USING ERRCODE = '22023';
  END IF;

  IF target_schema::text <> 'app' THEN
    RAISE EXCEPTION 'tenant isolation may only be applied to tables in schema app, got %.%',
      target_schema, target_table
      USING ERRCODE = '22023';
  END IF;

  SELECT c.oid, c.relkind, c.relowner
  INTO target_oid, target_kind, target_owner
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = target_schema::text
    AND c.relname = target_table::text;

  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'target table %.% does not exist', target_schema, target_table
      USING ERRCODE = '42P01';
  END IF;

  IF target_kind <> 'r' THEN
    RAISE EXCEPTION 'target %.% must be an ordinary table; relation kind is %',
      target_schema, target_table, target_kind
      USING ERRCODE = '42809';
  END IF;

  IF target_table::text IN (
    'schools',
    'plans',
    'plan_prices',
    'countries',
    'currencies',
    'platform_settings'
  ) THEN
    RAISE EXCEPTION 'global table %.% cannot receive tenant isolation', target_schema, target_table
      USING ERRCODE = '22023';
  END IF;

  SELECT r.oid INTO admin_oid
  FROM pg_catalog.pg_roles AS r
  WHERE r.rolname = 'studafy_admin';

  IF target_owner <> admin_oid THEN
    RAISE EXCEPTION 'tenant table %.% must be owned by studafy_admin, not %',
      target_schema, target_table, pg_catalog.pg_get_userbyid(target_owner)
      USING ERRCODE = '42501';
  END IF;

  SELECT c.oid INTO schools_oid
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = 'schools' AND c.relkind = 'r';

  SELECT a.attnum, a.atttypid, a.atttypmod
  INTO canonical_attnum, canonical_type, canonical_typmod
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = schools_oid
    AND a.attname = 'id'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  SELECT a.attnum, a.atttypid, a.atttypmod, a.attnotnull
  INTO school_id_attnum, school_id_type, school_id_typmod, school_id_not_null
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = target_oid
    AND a.attname = 'school_id'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF school_id_attnum IS NULL THEN
    RAISE EXCEPTION 'tenant table %.% must contain school_id', target_schema, target_table
      USING ERRCODE = '42703';
  END IF;

  IF school_id_type <> canonical_type OR school_id_typmod <> canonical_typmod THEN
    RAISE EXCEPTION '%.%.school_id type % must match app.schools.id type %',
      target_schema,
      target_table,
      pg_catalog.format_type(school_id_type, school_id_typmod),
      pg_catalog.format_type(canonical_type, canonical_typmod)
      USING ERRCODE = '42804';
  END IF;

  IF NOT school_id_not_null THEN
    RAISE EXCEPTION 'tenant table %.%.school_id must be NOT NULL', target_schema, target_table
      USING ERRCODE = '23502';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS con
    WHERE con.conrelid = target_oid
      AND con.contype = 'f'
      AND con.confrelid = schools_oid
      AND con.conkey = ARRAY[school_id_attnum]::smallint[]
      AND con.confkey = ARRAY[canonical_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION '%.%.school_id must have a single-column foreign key to app.schools(id)',
      target_schema, target_table
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS p
    WHERE p.polrelid = target_oid
      AND p.polname <> 'tenant_isolation'
      AND p.polpermissive
  ) THEN
    RAISE EXCEPTION 'table %.% has another permissive policy that could broaden tenant access',
      target_schema, target_table
      USING ERRCODE = '22023';
  END IF;

  SELECT
    p.polcmd,
    p.polpermissive,
    p.polroles,
    pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using_expression,
    pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
  INTO canonical_policy
  FROM pg_catalog.pg_policy AS p
  WHERE p.polrelid = target_oid
    AND p.polname = 'tenant_isolation';
  canonical_policy_found := FOUND;

  IF canonical_policy_found THEN
    normalized_using := pg_catalog.regexp_replace(
      pg_catalog.replace(canonical_policy.using_expression, '::text', ''),
      '[[:space:]()]',
      '',
      'g'
    );
    normalized_check := pg_catalog.regexp_replace(
      pg_catalog.replace(canonical_policy.check_expression, '::text', ''),
      '[[:space:]()]',
      '',
      'g'
    );

    IF canonical_policy.polcmd <> '*'
       OR NOT canonical_policy.polpermissive
       OR canonical_policy.polroles <> ARRAY[0::oid]
       OR normalized_using <> expected_expression
       OR normalized_check <> expected_expression THEN
      RAISE EXCEPTION 'existing tenant_isolation policy on %.% is incompatible',
        target_schema, target_table
        USING ERRCODE = '22023';
    END IF;
  END IF;

  EXECUTE pg_catalog.format(
    'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
    target_schema,
    target_table
  );
  EXECUTE pg_catalog.format(
    'ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
    target_schema,
    target_table
  );

  IF NOT canonical_policy_found THEN
    EXECUTE pg_catalog.format(
      'CREATE POLICY tenant_isolation ON %I.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (school_id = current_setting(''app.school_id'')::uuid) '
      'WITH CHECK (school_id = current_setting(''app.school_id'')::uuid)',
      target_schema,
      target_table
    );
  END IF;
END
$function$;

ALTER FUNCTION app.apply_tenant_isolation(name, name) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.apply_tenant_isolation(name, name) FROM PUBLIC, studafy_app;
GRANT EXECUTE ON FUNCTION app.apply_tenant_isolation(name, name) TO studafy_admin;

RESET ROLE;
