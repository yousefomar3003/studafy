-- Creates app.audit_logs: the school-owned, append-only record of who changed what, when, and from
-- where. It is declaratively range-partitioned by month on created_at, for the same reasons attendance
-- is (000012): an audit log is the other unbounded-growth table in the product, and monthly partitions
-- keep vacuum, index maintenance, and history queries bounded. See docs/database/audit-logs-data-model.md
-- for the full design note and docs/database/audit-log-partition-maintenance.md for the operational
-- runbook.
--
-- STATED ASSUMPTION ON THE SCHEMA SHAPE. The ST-046 ticket cites "SAD section 15" as the source of this
-- table's shape. The SAD is not in this repository -- docs/api/global-data-erd.md records the same gap
-- for section 10 -- so the column list below is taken from the ticket's own normalization requirements
-- rather than inferred from a document nobody here can read. If the SAD later contradicts this, a
-- follow-up migration reconciles it; this file is not edited after it is applied.
--
-- The append-only contract is enforced at two independent layers, because one is not enough:
--
-- 1. GRANTS. studafy_app holds SELECT and INSERT and nothing else. PostgreSQL checks privileges before
--    it checks row policies, so this is what actually makes the table append-only for the runtime role
--    -- the canonical FOR ALL tenant policy below cannot widen it. The explicit REVOKE from studafy_app
--    is mandatory and not decoration: 000002 sets ALTER DEFAULT PRIVILEGES granting studafy_app
--    SELECT/INSERT/UPDATE/DELETE on every table studafy_admin creates in this schema, so a new table
--    arrives with UPDATE and DELETE already granted, and a bare GRANT SELECT, INSERT would leave them.
--
-- 2. A TRIGGER. Grants do not bind studafy_admin, which owns the table. An audit log that its own DBA
--    role can rewrite in place is not an audit log, so trg_audit_logs_append_only rejects every UPDATE
--    and DELETE from every role, owner included. This does not obstruct retention: dropping a month is
--    DDL (DROP TABLE / DETACH PARTITION), not a row DELETE, and is unaffected.
--
-- Three consequences of partitioning, handled explicitly rather than papered over:
--
-- a. PostgreSQL can only enforce a UNIQUE constraint on a partitioned table if the constraint contains
--    the partition key, so the primary key is (id, created_at). id ALONE IS THEREFORE NOT ENFORCED
--    UNIQUE ACROSS PARTITIONS. It is a gen_random_uuid() surrogate -- a cryptographically random v4
--    UUID with 122 bits of entropy -- so a collision is not a practical risk, but the database does not
--    guarantee it and this migration does not claim that it does. Consumers must treat
--    (id, created_at) as the physical row identity; id is the stable logical audit identifier.
--
-- b. RLS does not cascade. ENABLE/FORCE ROW LEVEL SECURITY on a partitioned parent does not recurse to
--    its partitions, and a parent policy is not consulted when a partition is named directly. studafy_app
--    can name a partition directly, so every leaf gets its own ENABLE + FORCE + canonical tenant_isolation
--    policy and its own append-only grants, applied by app.create_audit_log_partitions at creation time.
--
-- c. Row triggers on a partitioned parent are cloned to every partition, including partitions attached
--    later, so the append-only trigger needs no per-partition work.
--
-- Timestamps are the schema's ordinary timestamptz, NOT the timestamptz(3) attendance uses. That
-- millisecond pinning exists in 000012 solely because a foreign key compares attendance's created_at for
-- equality across a driver round-trip. Nothing references app.audit_logs -- an audit log is a leaf, by
-- construction -- so the constraint does not apply here and full timestamptz precision is kept.
--
-- There is deliberately no updated_at. Every other table in this schema carries one plus a
-- ck_<table>_timestamps check. An append-only row can never be updated, so an updated_at would be a
-- column permanently equal to created_at that depends on nothing and promises an affordance the table
-- does not have. Its absence is the schema stating the contract.

SET ROLE studafy_admin;

-- The DML verbs an audit row can describe, plus the security-relevant events that are not row changes
-- (a login leaves no old/new state but is exactly what an auditor searches for). An enum rather than
-- free text because the action is a closed domain and 1NF is enforced by the database here, not by
-- convention; extending it later is a one-line ALTER TYPE ... ADD VALUE in a new migration.
CREATE TYPE app.audit_action AS ENUM (
  'insert',
  'update',
  'delete',
  'login',
  'logout',
  'export',
  'permission_change'
);

-- One audited event. The relational envelope -- who (actor_id), under which tenant (school_id), what
-- kind of change (action), against which record (target_table, target_id), from where (client_ip,
-- user_agent), and when (created_at) -- is atomic columns, never packed into JSON. The JSONB payload
-- carries only the record states.
--
-- old_values and new_values are jsonb, and that is the one deliberate denormalization in this table. An
-- audit log must capture the before/after state of ANY table in the schema, each with a different and
-- independently evolving column set; a relational representation would mean either one column per
-- auditable attribute across the whole product (unworkable) or an EAV key/value child table (which
-- loses type fidelity and costs a join per audited row). jsonb captures the polymorphic delta exactly.
-- The rule that keeps this honest: the JSONB holds PAYLOAD STATE ONLY. No routing or ownership column
-- -- school_id, actor_id, target_id, action -- is ever read out of it. Those are columns, indexed and
-- constrained, because the tenant boundary and every query path depend on them.
--
-- actor_id is nullable: a system-initiated change (a scheduled job, a cascade, an unauthenticated login
-- attempt) has no user behind it, and a synthetic "system user" row would be a lie in app.users. The
-- composite FK below is MATCH SIMPLE (PostgreSQL's default), so it is simply not checked when actor_id
-- is NULL, while school_id stays NOT NULL and the tenant boundary holds regardless. This mirrors
-- attendance_sessions.taken_by_user_id.
--
-- 3NF: no actor email, actor name, or school name is copied here. Those are functionally dependent on
-- actor_id and school_id, which are foreign keys; duplicating them would create transitive dependencies
-- and let the audit log drift out of step with the entities it points at.
CREATE TABLE app.audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  actor_id uuid,
  action app.audit_action NOT NULL,
  target_table text NOT NULL,
  target_id uuid NOT NULL,
  old_values jsonb,
  new_values jsonb,
  client_ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_audit_logs PRIMARY KEY (id, created_at),
  -- The partition-key-inclusive analogue of the house uq_<table>_id_school candidate key. It is what
  -- makes (id, school_id, created_at) a tenant-checked identity for an audit row, and it backs the
  -- pruned lookup of one audit row by id.
  CONSTRAINT uq_audit_logs_id_school_created UNIQUE (id, school_id, created_at),
  CONSTRAINT fk_audit_logs_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- target_table names a relation in this schema, so it is bounded by PostgreSQL's own identifier
  -- length. It is not a foreign key to pg_class: the audit row must survive the table it describes
  -- being renamed or dropped, which a catalog reference would prevent.
  CONSTRAINT ck_audit_logs_target_table CHECK (
    target_table = btrim(target_table)
    AND target_table <> ''
    AND char_length(target_table) <= 63
  ),
  CONSTRAINT ck_audit_logs_old_values CHECK (
    old_values IS NULL OR jsonb_typeof(old_values) = 'object'
  ),
  CONSTRAINT ck_audit_logs_new_values CHECK (
    new_values IS NULL OR jsonb_typeof(new_values) = 'object'
  ),
  CONSTRAINT ck_audit_logs_user_agent CHECK (
    user_agent IS NULL OR (user_agent = btrim(user_agent) AND user_agent <> '')
  ),
  -- The payload must agree with the verb. An 'insert' has no prior state, a 'delete' has no subsequent
  -- state, and an 'update' has both -- otherwise the row is not a delta anyone can reconstruct. The
  -- non-DML actions ('login', 'export', ...) describe no row change and are free to carry neither.
  CONSTRAINT ck_audit_logs_payload CHECK (
    CASE action
      WHEN 'insert' THEN old_values IS NULL AND new_values IS NOT NULL
      WHEN 'update' THEN old_values IS NOT NULL AND new_values IS NOT NULL
      WHEN 'delete' THEN old_values IS NOT NULL AND new_values IS NULL
      ELSE true
    END
  )
) PARTITION BY RANGE (created_at);

-- Layer 2 of the append-only contract (see the header). Grants stop studafy_app; this stops everyone,
-- including studafy_admin, which owns the table and is therefore not bound by grants at all.
--
-- BEFORE ... FOR EACH ROW, so it fires on the partition the row actually lives in: a row trigger on a
-- partitioned parent is cloned to every partition and to every partition attached later, which means a
-- direct UPDATE against app.audit_logs_y2026m07 is rejected exactly like one against the parent.
-- A statement-level trigger would not give that, and a policy could not do it at all -- RLS can hide
-- rows from a mutation, but it cannot make the mutation itself an error.
--
-- 42501 (insufficient_privilege) is the deliberate SQLSTATE: to a caller this is a permissions failure,
-- and it is the same class the grant layer raises, so callers need one error path, not two.
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

-- Indexes are declared on the partitioned parent. PostgreSQL creates a matching partition-local index on
-- every existing partition and on every partition attached later, so app.create_audit_log_partitions
-- never creates indexes itself and no index is ever declared twice.
--
-- An audit log is write-heavy and read-sparse, so every index is a permanent tax on the write path and
-- only the three access paths the product actually has are indexed. school_id leads all three: it
-- satisfies the RLS predicate's equality lookup, and it is the only column present in every audit query
-- by construction, since a query that does not name a school cannot see a row.
--
-- Partition pruning is a SEPARATE mechanism from these indexes and depends on created_at, not on
-- school_id. A query filtered only by school_id and target_id still probes the index on EVERY monthly
-- partition. Audit searches must carry a temporal bound; see the pruning guide in
-- docs/database/audit-logs-data-model.md.

-- Target investigation, the primary audit path: every change ever made to one business record, newest
-- first. created_at DESC is in the index so the ORDER BY is satisfied by the scan, not a sort.
CREATE INDEX idx_audit_logs_school_target
  ON app.audit_logs (school_id, target_table, target_id, created_at DESC);
-- Actor investigation: everything one user or admin did, newest first. Its (school_id, actor_id) prefix
-- also backs the actor foreign key's parent-update check.
CREATE INDEX idx_audit_logs_school_actor
  ON app.audit_logs (school_id, actor_id, created_at DESC);
-- Temporal school audit: everything that happened in a school across a window. This is NOT redundant
-- with the two above -- neither has created_at in second position, so neither can serve a query that
-- constrains only school and time.
CREATE INDEX idx_audit_logs_school_created
  ON app.audit_logs (school_id, created_at DESC);

-- No standalone index on school_id: it is the leftmost prefix of all three composites above and would be
-- pure write amplification.

REVOKE ALL PRIVILEGES ON TABLE app.audit_logs FROM PUBLIC;
-- Mandatory, not decoration -- see layer 1 in the header. 000002's default privileges have already
-- granted studafy_app UPDATE and DELETE on this table by the time this line runs.
REVOKE ALL PRIVILEGES ON TABLE app.audit_logs FROM studafy_app;
GRANT SELECT, INSERT ON TABLE app.audit_logs TO studafy_app;

REVOKE ALL ON TYPE app.audit_action FROM PUBLIC;
GRANT USAGE ON TYPE app.audit_action TO studafy_app;

-- The canonical ST-034 tenant policy, permissive FOR ALL. It cannot widen the append-only grants above:
-- privileges are checked before policies, so studafy_app still has no UPDATE or DELETE to apply it to.
-- The helper accepts a partitioned parent (relkind 'p') since its forward amendment in 000012.
SELECT app.apply_tenant_isolation('app', 'audit_logs');

-- Creates the monthly partition of app.audit_logs for the month containing target_month and returns the
-- names it created (empty when it already existed). Administrative DDL: SECURITY INVOKER and granted only
-- to studafy_admin, so the runtime role cannot reach it even though it can append audit rows.
--
-- Month boundaries are UTC and half-open, [first instant of the month, first instant of the next): the
-- function pins timezone = 'UTC' for its own duration so a partition's bounds never depend on the
-- server's or the caller's TimeZone setting.
--
-- Idempotent: an existing partition whose bounds already match is left alone. Anything else occupying the
-- name -- a table that is not a partition of this parent, or a partition with different bounds -- raises
-- rather than being silently altered, because rewriting a live partition's bounds would either lose rows
-- or fail halfway.
--
-- There is deliberately no DEFAULT partition. A default partition would silently absorb rows for a month
-- whose partition maintenance had failed, turning a loud, immediately fixable error into an unbounded
-- heap of misfiled audit records discovered months later -- and in an audit log, silently misfiled is
-- indistinguishable from lost.
--
-- This mirrors app.create_attendance_partitions (000012) deliberately, with one substantive difference:
-- the grants a new partition receives are SELECT, INSERT -- never UPDATE or DELETE -- so a partition
-- created by the scheduled job six months from now is as append-only as the ones created here.
CREATE FUNCTION app.create_audit_log_partitions(target_month date)
RETURNS text[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET timezone = 'UTC'
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
  -- The append-only grants, restated per partition. The REVOKE from studafy_app is required for the same
  -- reason it is required on the parent: 000002's default privileges have already granted the runtime
  -- role UPDATE and DELETE on this brand-new table. Without it, every partition would be a silent hole in
  -- the append-only contract that the parent's grants appear to establish.
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE app.%I FROM PUBLIC', partition_name);
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE app.%I FROM studafy_app', partition_name);
  EXECUTE pg_catalog.format(
    'GRANT SELECT, INSERT ON TABLE app.%I TO studafy_app',
    partition_name
  );
  -- A partition is directly nameable by studafy_app and does not inherit the parent's policy, so it gets
  -- its own ENABLE + FORCE + canonical tenant_isolation here. Without this line every new partition would
  -- be a tenant-isolation hole.
  PERFORM app.apply_tenant_isolation('app', partition_name);

  created := created || partition_name;

  RETURN created;
END
$function$;

-- Creates every missing monthly partition from the current UTC month through months_ahead months later.
-- This is what the scheduled maintenance job calls; it is safe to run repeatedly and returns the names it
-- actually created so the job can log them.
CREATE FUNCTION app.ensure_audit_log_partitions(months_ahead integer DEFAULT 3)
RETURNS text[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET timezone = 'UTC'
AS $function$
DECLARE
  created text[] := ARRAY[]::text[];
  month_offset integer;
BEGIN
  IF months_ahead IS NULL OR months_ahead < 0 OR months_ahead > 24 THEN
    RAISE EXCEPTION 'months_ahead must be between 0 and 24, got %', months_ahead
      USING ERRCODE = '22023';
  END IF;

  FOR month_offset IN 0..months_ahead LOOP
    created := created || app.create_audit_log_partitions(
      (pg_catalog.date_trunc('month', CURRENT_TIMESTAMP)
        + pg_catalog.make_interval(months => month_offset))::date
    );
  END LOOP;

  RETURN created;
END
$function$;

ALTER FUNCTION app.create_audit_log_partitions(date) OWNER TO studafy_admin;
ALTER FUNCTION app.ensure_audit_log_partitions(integer) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.create_audit_log_partitions(date) FROM PUBLIC, studafy_app;
REVOKE ALL ON FUNCTION app.ensure_audit_log_partitions(integer) FROM PUBLIC, studafy_app;
GRANT EXECUTE ON FUNCTION app.create_audit_log_partitions(date) TO studafy_admin;
GRANT EXECUTE ON FUNCTION app.ensure_audit_log_partitions(integer) TO studafy_admin;

-- The initial partition range is written out as fixed months rather than derived from CURRENT_DATE so that
-- this migration is deterministic: the same file must produce the same schema whenever it is applied, and
-- its checksum is immutable. ST-046 was authored in 2026-07, so this covers the previous month, the
-- current month, and six months ahead -- the same horizon 000012 gave attendance. Beyond 2027-01 the
-- rolling horizon is the maintenance job's responsibility; see
-- docs/database/audit-log-partition-maintenance.md. A database first migrated after 2027-01 has no usable
-- audit partition until that job has run once, and an insert will fail loudly (23514) until it does.
SELECT app.create_audit_log_partitions('2026-06-01');
SELECT app.create_audit_log_partitions('2026-07-01');
SELECT app.create_audit_log_partitions('2026-08-01');
SELECT app.create_audit_log_partitions('2026-09-01');
SELECT app.create_audit_log_partitions('2026-10-01');
SELECT app.create_audit_log_partitions('2026-11-01');
SELECT app.create_audit_log_partitions('2026-12-01');
SELECT app.create_audit_log_partitions('2027-01-01');

RESET ROLE;
