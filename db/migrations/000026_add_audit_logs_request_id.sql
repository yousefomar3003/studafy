-- Adds request_id to app.audit_logs: the correlation key joining one audit row to the API log lines for
-- the request that produced it (ST-054). apps/api generates a UUIDv4 per request, logs it as request_id,
-- returns it as X-Request-Id, and sets it as the transaction-local app.request_id GUC in
-- withTenantTransaction. See docs/architecture/SAD_28_logging_conventions.md for the full request
-- lifecycle and docs/database/audit-logs-data-model.md for this table's design note.
--
-- STATED ASSUMPTION ON THE COLUMN. The ST-054 ticket cites "SAD section 28" as the source of the logging
-- and tracing format. The SAD is not in this repository -- 000018 records the same gap for section 15,
-- and docs/api/global-data-erd.md for section 10 -- so this column is taken from the ticket's own stated
-- requirement to align log metadata with the audit trail, rather than inferred from a document nobody
-- here can read. If the SAD later contradicts this, a follow-up migration reconciles it. 000018 is not
-- edited; this is the forward migration.
--
-- THERE IS NO WRITER. Nothing in this repository inserts an app.audit_logs row -- not the API, not the
-- workers. This column is therefore NULL on every row that exists today and on every row anything
-- currently creates. That is deliberate, and it is the expand half of the expand/migrate/contract policy
-- in docs/database/migration-policy.md: the column is nullable and backward compatible, and the ticket
-- that adds the audit writer populates it. ST-054 ships the transport (the GUC) and the destination (this
-- column) together so that writer only has to add the INSERT.
--
-- NULLABLE IS PERMANENT, not a placeholder for a later NOT NULL. The migrations CLI, the workers, and the
-- scheduled partition-maintenance job all legitimately write with no HTTP request behind them, so a NULL
-- request_id is a correct and expected state for those rows -- forever. Do not add a NOT NULL constraint
-- to this column.
--
-- ANY FUTURE READER MUST PASS missing_ok: current_setting('app.request_id', true). This is the exact trap
-- app.current_user_id() (000014) already sits in -- it calls current_setting('app.user_id') without the
-- second argument and so raises 42704 when the GUC is unset. app.request_id is unset by construction for
-- every non-HTTP write, so a reader without missing_ok would turn each of those into an error.
--
-- NO INDEX, deliberately, and this is a documented omission rather than an oversight -- the indexing
-- standard in docs/database/migration-policy.md requires every index to have a named query, integrity,
-- join, filter, sort, or pagination purpose, and requires an intentional omission to be documented. There
-- is no such query: no writer, no reader, no endpoint. app.audit_logs is the most write-heavy table in
-- the schema and 000018 already justifies each of its three indexes as a permanent tax on that write
-- path; a fourth to serve a hypothesis is precisely the speculative index the standard forbids. When a
-- real lookup arrives it will not want a bare request_id index anyway: a tenant-blind index is
-- school-last, prunes no monthly partition, and contradicts the school-leading shape the RLS coverage
-- check (ST-050) expects of every tenant-scoped table. The index that query will want is
-- idx_audit_logs_school_request_created (school_id, request_id, created_at DESC), and it belongs to the
-- ticket that can name the query and measure it.
--
-- CASCADE AND GRANTS, stated rather than assumed:
--
--  * ADD COLUMN on a partitioned parent recurses to every existing partition automatically; PostgreSQL
--    rejects ALTER TABLE ONLY ... ADD COLUMN on a partitioned table outright, so there is no variant of
--    this statement that could leave a partition behind. Partitions created later by
--    app.create_audit_log_partitions use CREATE TABLE ... PARTITION OF, which inherits the parent's
--    column list as it stands at creation time. That function needs no change.
--
--  * The append-only grants in 000018 are table-level (GRANT SELECT, INSERT ON TABLE ... TO studafy_app),
--    and a table-level privilege covers every column of the table, including ones added afterwards. There
--    are no column-level grants here, so no grant change is required on the parent or on any partition,
--    and nothing below widens studafy_app past SELECT and INSERT.
--
--  * Neither tenant isolation nor the append-only trigger is disturbed: the tenant_isolation policy keys
--    on school_id, and trg_audit_logs_append_only fires on UPDATE and DELETE only. app.apply_tenant_isolation
--    is not re-run -- it is idempotent, but re-running it here would be noise, not safety.
--
-- LOCKING. A nullable column with no default is a catalog-only change since PostgreSQL 11: no table
-- rewrite, and the statement itself is O(1) regardless of how many rows the partitions hold. It still
-- takes ACCESS EXCLUSIVE on the parent and on every partition for its duration, though, and that is not
-- free of a blocker -- a long-running reader would queue writes behind it. The lock_timeout below is the
-- conservative bound migration-policy.md asks for on a migration that takes a heavy lock: fail fast and
-- retry in a quieter moment rather than stall the audit write path.

SET ROLE studafy_admin;

SET LOCAL lock_timeout = '5s';

ALTER TABLE app.audit_logs ADD COLUMN request_id uuid;

COMMENT ON COLUMN app.audit_logs.request_id IS
  'API request that produced this row (ST-054), from the transaction-local app.request_id GUC. NULL for '
  'writes with no HTTP request behind them -- migrations, workers, scheduled jobs. Read with '
  'current_setting(''app.request_id'', true); without missing_ok it raises 42704 when unset.';

RESET ROLE;
