-- Canonical tenant-table discovery for the tenant-slice restore tooling (ST-267).
--
-- Reuses the exact classification db/policies/rls-coverage.ts already treats as ground truth: an
-- app-schema relation is "tenant" if it carries a non-dropped school_id column
-- (rls-coverage.ts's own `tenant_relations`). Restricted to non-partition relations
-- (`NOT c.relispartition`) so a partitioned family (app.attendance_records,
-- app.audit_logs, ...) appears once under its parent's name rather than once per monthly
-- partition -- pg_dump/COPY against the parent transparently reads/writes every partition, and
-- app.apply_tenant_isolation (db/migrations/000006, amended in 000012) already guarantees every
-- partition carries the identical tenant_isolation policy as its parent.
--
-- `lvl` is a topological depth: 0 for a table with no FK to another tenant table in this set, and
-- max(parent depth) + 1 otherwise. Loading tables in ascending `lvl` order (and, for a real
-- rollback, deleting in descending order) satisfies every FK between tenant tables without needing
-- to defer constraints -- db/policies/rls-coverage.ts's own TENANT_COMPOSITE_FOREIGN_KEY rule
-- already guarantees every such FK carries school_id in its key, so this is a same-tenant DAG, not
-- a cross-tenant one.
--
-- Output columns: table_name, lvl, is_partitioned. Ordered so a naive `while read` loop already
-- produces a valid load order.
--
-- is_partitioned (relkind = 'p') matters to extract-tenant-slice.sh specifically: pg_dump's
-- --table=app.<name> matches only that exact relation. For a partitioned parent, that dumps the
-- parent's own (always empty -- rows live in partitions) data via an implicit `FROM ONLY`; the
-- partitions' data goes untouched unless --table is a pattern that also matches them
-- (app.<name>*, since every partition of app.audit_logs/app.attendance_records/... is named with
-- the parent's name as a literal prefix -- see db/migrations/000012, 000018).
WITH RECURSIVE tenant_tables AS (
  SELECT c.oid, c.relname, c.relkind
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute AS school
    ON school.attrelid = c.oid
   AND school.attname = 'school_id'
   AND school.attnum > 0
   AND NOT school.attisdropped
  WHERE n.nspname = 'app'
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
),
edges AS (
  SELECT DISTINCT con.conrelid AS child_oid, con.confrelid AS parent_oid
  FROM pg_catalog.pg_constraint AS con
  JOIN tenant_tables AS child ON child.oid = con.conrelid
  JOIN tenant_tables AS parent ON parent.oid = con.confrelid
  WHERE con.contype = 'f'
    AND con.conrelid <> con.confrelid
),
levels(oid, lvl) AS (
  SELECT oid, 0 FROM tenant_tables WHERE oid NOT IN (SELECT child_oid FROM edges)
  UNION
  SELECT e.child_oid, l.lvl + 1
  FROM edges e JOIN levels l ON l.oid = e.parent_oid
)
SELECT t.relname AS table_name, max(coalesce(l.lvl, 0)) AS lvl, (t.relkind = 'p') AS is_partitioned
FROM tenant_tables t
LEFT JOIN levels l ON l.oid = t.oid
GROUP BY t.relname, t.relkind
ORDER BY lvl, t.relname;
