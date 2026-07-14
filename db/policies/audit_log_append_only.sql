-- Reference mirror of the tenant isolation and append-only enforcement installed on app.audit_logs by
-- migration 000018. This file is documentation: the runner only executes db/migrations. It is kept
-- byte-faithful to the migration so a reviewer can read the security posture of the audit log without
-- reading a 300-line migration, and so a drift between the two is visible in review.
--
-- Design note: docs/database/audit-logs-data-model.md
-- Runbook:     docs/database/audit-log-partition-maintenance.md

-- ---------------------------------------------------------------------------------------------------
-- 1. Tenant isolation -- the canonical ST-034 policy, unmodified.
-- ---------------------------------------------------------------------------------------------------

SELECT app.apply_tenant_isolation('app', 'audit_logs');

-- The helper enables AND forces RLS and installs exactly this policy. It accepts a partitioned parent
-- (relkind 'p') since its forward amendment in 000012.
--
-- CREATE POLICY tenant_isolation ON app.audit_logs
--   AS PERMISSIVE
--   FOR ALL
--   TO PUBLIC
--   USING (school_id = current_setting('app.school_id')::uuid)
--   WITH CHECK (school_id = current_setting('app.school_id')::uuid);
--
-- FOR ALL is not a widening. Privileges are checked BEFORE row policies, so a policy cannot grant an
-- UPDATE that the grants below withhold. There is no restrictive policy on this table and there should
-- not be one: append-only is a privilege question, and RLS is the wrong instrument for it -- a policy can
-- hide rows from a mutation, but it cannot make the mutation itself an error.

-- ---------------------------------------------------------------------------------------------------
-- 2. Append-only, layer one: grants.
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.audit_logs FROM PUBLIC;
-- MANDATORY, and the single easiest line in this schema to omit by accident.
--
-- 000002 establishes:
--   ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin IN SCHEMA app
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO studafy_app;
--
-- so app.audit_logs arrives with UPDATE and DELETE ALREADY GRANTED to the runtime role. Writing only
-- `GRANT SELECT, INSERT` would leave them in place, and the table would look append-only in review while
-- being freely rewritable in production. The REVOKE is what actually makes the guarantee.
REVOKE ALL PRIVILEGES ON TABLE app.audit_logs FROM studafy_app;
GRANT SELECT, INSERT ON TABLE app.audit_logs TO studafy_app;

REVOKE ALL ON TYPE app.audit_action FROM PUBLIC;
GRANT USAGE ON TYPE app.audit_action TO studafy_app;

-- Resulting posture, asserted by packages/db/tests/audit-logs.test.ts on the parent AND on every
-- partition (RLS does not cascade and grants are not inherited, so both are checked at every leaf):
--
--   role           SELECT  INSERT  UPDATE  DELETE  TRUNCATE
--   studafy_app      yes     yes      NO      NO       NO
--   PUBLIC            no      no      no      no       no
--   studafy_admin   owner (grants do not bind it -- see layer two)

-- ---------------------------------------------------------------------------------------------------
-- 3. Append-only, layer two: a trigger, because grants do not bind the owner.
-- ---------------------------------------------------------------------------------------------------

-- studafy_admin owns app.audit_logs and is therefore not subject to the grants above. An audit log that
-- its own DBA role can rewrite in place is not an audit log. This rejects every UPDATE and DELETE from
-- every role, owner included.
--
-- BEFORE ... FOR EACH ROW: a row trigger on a partitioned parent is cloned to every partition, and to
-- every partition attached later, so a direct UPDATE against app.audit_logs_y2026m07 is rejected exactly
-- like one against the parent. app.create_audit_log_partitions does not install it per-partition, and
-- does not need to.
--
-- 42501 (insufficient_privilege) is deliberate: to a caller this IS a permissions failure, and it is the
-- same error class the grant layer raises, so callers need one error path rather than two.
--
-- This does NOT obstruct retention. Dropping or detaching a month is DDL (DROP TABLE / ALTER TABLE ...
-- DETACH PARTITION), not a row DELETE, and the trigger does not apply to it.

CREATE FUNCTION app.reject_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'app.audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = '42501';
END
$function$;

CREATE TRIGGER trg_audit_logs_append_only
BEFORE UPDATE OR DELETE
ON app.audit_logs
FOR EACH ROW EXECUTE FUNCTION app.reject_audit_log_mutation();

ALTER FUNCTION app.reject_audit_log_mutation() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.reject_audit_log_mutation() FROM PUBLIC, studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 4. Every partition repeats all of the above.
-- ---------------------------------------------------------------------------------------------------

-- RLS does not cascade to partitions, and grants are not inherited by them. studafy_app can name a
-- partition directly, so a partition created without its own forced policy and its own append-only grants
-- would be BOTH a tenant-isolation hole AND a rewritable month of the audit log.
--
-- app.create_audit_log_partitions (000018) therefore does this at creation time, for every month it makes
-- -- including the months the scheduled maintenance job will create years from now, long after this file
-- was last read by a human:
--
--   EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE app.%I FROM PUBLIC', partition_name);
--   EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE app.%I FROM studafy_app', partition_name);
--   EXECUTE format('GRANT SELECT, INSERT ON TABLE app.%I TO studafy_app', partition_name);
--   PERFORM app.apply_tenant_isolation('app', partition_name);
--
-- Never create a partition by hand with a bare CREATE TABLE ... PARTITION OF ...: that skips all four
-- lines. Use `bun run db:audit:partitions`, or call app.create_audit_log_partitions('<month>') directly.
-- See the runbook's verification queries -- has_table_privilege('studafy_app', <partition>, 'UPDATE')
-- returning true on any partition is a security incident, not cosmetic drift.
