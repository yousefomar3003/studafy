-- QA-074: two loose ends from earlier migrations.
--
-- 1. 000003's pg_stat_statements grants never ran on production. Supabase installs the extension in
--    its own `extensions` schema and keeps the admin option on pg_read_all_stats, so production
--    applied 000003 without its three monitoring statements but recorded the file's real checksum
--    (infra/fly/README.md, "Where Supabase differs from RDS"). The checksum check therefore
--    approves a schema that was never fully applied, and PUBLIC can still read every statement's
--    text in pg_stat_statements. This re-applies the revoke wherever the view is installed, and the
--    grants to studafy_monitor where this role is allowed to give them. Each step is attempted on
--    its own and only reported when the platform refuses it, so the migration applies on both the
--    plain PostgreSQL used in CI and Supabase.
--
-- 2. app.register_school (000041) is SECURITY DEFINER with `search_path = app`. Its body is fully
--    schema-qualified today, but an unqualified name added later would resolve through a path a
--    caller might influence; 000202 grants TEMPORARY to PUBLIC on Supabase, which puts pg_temp in
--    play. It now pins `pg_catalog, pg_temp`, the convention every newer definer function follows.

DO $$
DECLARE
  stats_schema text;
BEGIN
  SELECT n.nspname INTO stats_schema
  FROM pg_extension AS e JOIN pg_namespace AS n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_stat_statements';
  IF stats_schema IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    EXECUTE format('REVOKE ALL ON %I.pg_stat_statements FROM PUBLIC', stats_schema);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING 'QA-074: could not revoke PUBLIC on %.pg_stat_statements; revoke it as its owner',
      stats_schema;
  END;
  IF to_regclass(format('%I.pg_stat_statements_info', stats_schema)) IS NOT NULL THEN
    BEGIN
      EXECUTE format('REVOKE ALL ON %I.pg_stat_statements_info FROM PUBLIC', stats_schema);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'QA-074: could not revoke PUBLIC on %.pg_stat_statements_info', stats_schema;
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studafy_monitor') THEN
    BEGIN
      EXECUTE format('GRANT SELECT ON %I.pg_stat_statements TO studafy_monitor', stats_schema);
      GRANT pg_read_all_stats TO studafy_monitor;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'QA-074: monitoring grants to studafy_monitor were refused (unused by the app)';
    END;
  END IF;
END
$$;

SET ROLE studafy_admin;

ALTER FUNCTION app.register_school(text, text, text, text, uuid, uuid)
  SET search_path = pg_catalog, pg_temp;

COMMENT ON FUNCTION app.register_school(text, text, text, text, uuid, uuid) IS
  'Creates a school in status registered (000041). SECURITY DEFINER, so the public registration '
  'flow can insert into app.schools, which is row-level secured (QA-016); search_path pinned to '
  'pg_catalog, pg_temp (QA-074).';

RESET ROLE;
