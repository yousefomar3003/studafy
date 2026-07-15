# Audit log partition maintenance

Operational runbook for the monthly partitions of `app.audit_logs`. The data model itself is documented
in [audit logs](audit-logs-data-model.md). The attendance family has its own runbook,
[attendance partition maintenance](attendance-partition-maintenance.md); the two are maintained by
separate commands on purpose, so one family's maintenance can be scheduled, retried, or rolled back
without touching the other.

## Overview

|                      |                                                                                  |
| -------------------- | -------------------------------------------------------------------------------- |
| Parent table         | `app.audit_logs`                                                                 |
| Partitioning         | declarative `PARTITION BY RANGE (created_at)`, one partition per calendar month  |
| Partition names      | `audit_logs_y2026m07`                                                            |
| Boundaries           | half-open, UTC: `FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00')`  |
| Default partition    | none, deliberately                                                               |
| Initial range        | 2026-06 through 2027-01, created by migration `000018`                           |
| Maintenance command  | `bun run db:audit:partitions [months-ahead]` (default 3)                         |
| Required role        | the administrative/migration identity; the command runs as `studafy_admin`       |
| Grants on partitions | `SELECT, INSERT` for `studafy_app` — **never** `UPDATE`, `DELETE`, or `TRUNCATE` |
| Retention            | out of scope — nothing is ever dropped automatically                             |

An audit log is unbounded-growth, write-heavy, read-sparse data. Monthly partitioning keeps vacuum,
index maintenance, and investigation queries bounded, and makes an eventual archive strategy a metadata
operation rather than a mass delete — which matters more here than anywhere else in the schema, because
a mass `DELETE` against the audit log is not possible at all (see
[append-only](#append-only-is-not-negotiable)).

### Partition key

`created_at` is both the partition key and the audit timestamp: when the event was recorded. Unlike
attendance, there is no separate business date — an audit row _is_ the record of an instant, so the two
concepts do not diverge and cannot get out of step.

The consequence for querying: **partition pruning depends on `created_at`, not on `school_id`**. An
audit search filtered only by school and target probes the index on every monthly partition. Every audit
query must carry a temporal bound. See the
[pruning guide](audit-logs-data-model.md#why-every-audit-query-needs-a-time-range).

### Timezone

Month boundaries are UTC. `app.create_audit_log_partitions` pins `timezone = 'UTC'` for the duration of
the call, so a partition's bounds never depend on the server's or the caller's `TimeZone` setting. A
school's local time zone is a presentation concern and deliberately does not affect physical partition
boundaries.

## Append-only is not negotiable

This is the one way this runbook differs materially from the attendance one, and it constrains every
operation below.

`app.audit_logs` is append-only at two independent layers:

1. **Grants.** `studafy_app` holds `SELECT` and `INSERT` and nothing else, on the parent _and on every
   partition_. PostgreSQL checks privileges before row policies, so this is what actually makes the
   table append-only for the runtime role.
2. **A trigger.** `trg_audit_logs_append_only` rejects every `UPDATE` and `DELETE` from **every** role,
   including `studafy_admin`, which owns the table and is therefore not bound by grants at all. Row
   triggers on a partitioned parent are cloned to every partition, including partitions attached later,
   so naming a partition directly is rejected exactly like naming the parent.

Practical consequences for an operator:

- You **cannot** correct a bad audit row in place, and you cannot delete one. That is the point. If a
  row is wrong, append a corrective row; the log is a history, not a state.
- You **can** still drop or detach a whole partition. Retention is DDL (`DROP TABLE`,
  `ALTER TABLE … DETACH PARTITION`), not a row `DELETE`, and the trigger does not apply to it.
- If you ever genuinely must mutate the log (a legal erasure order, say), the only path is a reviewed
  migration that drops the trigger, performs the change, and restores it — deliberately loud, auditable,
  and impossible to do by accident from a psql session.

## The maintenance command

```
bun run db:audit:partitions        # ensure current month + 3 months ahead
bun run db:audit:partitions 6      # ensure current month + 6 months ahead
```

It reads the same configuration as the migration runner (`DATABASE_URL`, or the discrete
`DATABASE_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD`, plus `DATABASE_SSL_MODE`), takes the migration runner's
advisory lock so maintenance cannot race another maintenance run (of either family) or a schema
migration, executes `SET LOCAL ROLE studafy_admin`, and calls
`app.ensure_audit_log_partitions(months_ahead)`.

It prints the partitions it created and then every audit partition with its bounds. It never prints
credentials; any error is passed through the same redaction the migration runner uses. Exit code is `0`
on success, `1` on failure, `2` on a usage error — so a scheduler will notice a failure.

The command is **idempotent**. A month whose partition already exists with matching bounds is skipped. A
relation squatting on a partition name with different bounds, or that is not a partition of
`app.audit_logs`, raises rather than being silently altered — rewriting a live partition's bounds would
either lose rows or fail halfway.

Underneath are two functions, both owned by `studafy_admin`, both revoked from `PUBLIC` and
`studafy_app`:

```sql
app.create_audit_log_partitions(target_month date) RETURNS text[]
app.ensure_audit_log_partitions(months_ahead integer DEFAULT 3) RETURNS text[]
```

### Recommended schedule

Run **weekly**, keeping at least **3 months** of headroom, from an in-VPC ECS/EventBridge task using the
signed migrations image and its existing Secrets Manager-backed administrative identity. The image's
normal entry point is the database CLI, so the task command override is:

```text
audit-partitions 3
```

ST-046 packages and verifies that command, but it does **not** deploy the EventBridge schedule — the
same gap ST-040 left for attendance, and it should be closed once for both families. A GitHub-hosted
cron was deliberately rejected: hosted runners cannot reach the private database, and putting a directly
reachable administrative `DATABASE_URL` in GitHub would conflict with the repository's Secrets Manager
and VPC conventions. Until an in-VPC scheduler is provisioned, run the command as a one-off migrations
task during deployment or by an operator with approved connectivity.

A database first migrated long after 2027-01 has no usable audit partition until the maintenance command
has run at least once, and **every audited write will fail** until it does. This is a sharper failure
than attendance's: if the application appends its audit row in the same transaction as the change it
audits, a missing partition fails the business transaction too. Run the command immediately after
`db:migrate`; CI does exactly that.

## Verifying

List the partitions and their bounds:

```sql
SELECT child.relname AS partition,
       pg_get_expr(child.relpartbound, child.oid) AS bounds
FROM pg_inherits AS i
JOIN pg_class AS child  ON child.oid  = i.inhrelid
JOIN pg_class AS parent ON parent.oid = i.inhparent
JOIN pg_namespace AS ns ON ns.oid = parent.relnamespace
WHERE ns.nspname = 'app' AND parent.relname = 'audit_logs'
ORDER BY child.relname;
```

Confirm a partition's security matches the parent — owner, forced RLS, canonical policy, and above all
the **append-only** grants:

```sql
SELECT c.relname,
       pg_get_userbyid(c.relowner)   AS owner,        -- must be studafy_admin
       c.relrowsecurity              AS rls,          -- must be true
       c.relforcerowsecurity         AS forced,       -- must be true
       (SELECT count(*) FROM pg_policy p
         WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,   -- must be 1
       has_table_privilege('studafy_app', c.oid, 'SELECT') AS app_select,          -- must be true
       has_table_privilege('studafy_app', c.oid, 'INSERT') AS app_insert,          -- must be true
       has_table_privilege('studafy_app', c.oid, 'UPDATE') AS app_update,          -- MUST be false
       has_table_privilege('studafy_app', c.oid, 'DELETE') AS app_delete,          -- MUST be false
       has_table_privilege('public',      c.oid, 'SELECT') AS public_can_read      -- must be false
FROM pg_class AS c
JOIN pg_namespace AS ns ON ns.oid = c.relnamespace
WHERE ns.nspname = 'app' AND c.relname LIKE 'audit\_logs\_y%m%';
```

`app_update` or `app_delete` coming back `true` on any partition is a **security incident**, not a
cosmetic drift: it means that month of the audit log is rewritable by the application.

Confirm the append-only trigger was cloned to the partition:

```sql
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'app.audit_logs_y2026m07'::regclass AND NOT tgisinternal;
-- expect: trg_audit_logs_append_only
```

Confirm the parent's indexes propagated to it:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE indrelid = 'app.audit_logs_y2026m07'::regclass;
-- expect 5: the primary key, the (id, school_id, created_at) unique, and the three composites
```

Confirm a row routed to the partition you expect:

```sql
SELECT tableoid::regclass, id, created_at FROM app.audit_logs WHERE id = '…';
```

Confirm no row is stranded in the parent (there should never be any):

```sql
SELECT count(*) FROM ONLY app.audit_logs;
```

## How new partitions inherit security

`app.create_audit_log_partitions` does all of this at creation time, so no manual security step is ever
required and none can be forgotten:

- **Owner** — the partition is created while the session is `studafy_admin`, so `studafy_admin` owns it.
- **Grants** — `REVOKE ALL … FROM PUBLIC`, then `REVOKE ALL … FROM studafy_app`, then
  `GRANT SELECT, INSERT … TO studafy_app`. The second `REVOKE` is **required**, not defensive: migration
  `000002` sets `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
studafy_app`, so a brand-new partition arrives with `UPDATE` and `DELETE` already granted. Granting
  `SELECT, INSERT` alone would leave them in place and every new month would silently be a mutable hole
  in an otherwise append-only table.
- **RLS** — `app.apply_tenant_isolation('app', <partition>)` enables **and forces** RLS and installs the
  canonical `tenant_isolation` policy.
- **Trigger** — not applied here. `trg_audit_logs_append_only` is a row trigger on the partitioned
  parent, and PostgreSQL clones it to every partition automatically on attach.
- **Indexes** — not created here. Indexes are declared on the partitioned parent, and PostgreSQL creates
  the partition-local index automatically when the partition is attached.

This is not optional bookkeeping. **RLS does not cascade, and grants are not inherited.** Enabling RLS on
a partitioned parent does not recurse to its partitions, and the parent's policy is not consulted when a
partition is queried directly. `studafy_app` can name a partition directly, so a partition without its
own forced policy and its own append-only grants would be both a tenant-isolation hole and a rewritable
audit log. The test suite asserts every partition — including ones created after the migration, by this
command — carries the same owner, grants, forced RLS, policy, and trigger as the parent.

## Failure modes

### Missing partition

Symptom, on insert:

```
ERROR: no partition of relation "audit_logs" found for row
DETAIL: Partition key of the failing row contains (created_at) = (2030-05-10 09:00:00+00).
SQLSTATE: 23514
```

This is the intended behaviour. There is **no `DEFAULT` partition**, on purpose: a default partition
would silently absorb rows for a month whose maintenance had failed, turning a loud and immediately
fixable error into an unbounded heap of misfiled audit records discovered months later. In an audit log,
silently misfiled is indistinguishable from lost.

Recovery — create the month and retry. The failed insert has no side effects:

```
bun run db:audit:partitions
```

or, for one specific month (as the administrative identity):

```sql
SET ROLE studafy_admin;
SELECT app.create_audit_log_partitions('2030-05-01');
RESET ROLE;
```

Then verify security on the new partition with the query above. Do **not** create the partition by hand
with `CREATE TABLE … PARTITION OF …`: that skips the `REVOKE`/`GRANT` and the forced RLS policy, leaving
the partition readable across tenants **and writable by the application**. If you truly must, run the
`REVOKE`/`GRANT` and `SELECT app.apply_tenant_isolation('app', '<partition>')` immediately afterwards, in
the same transaction.

### Backdated imports

A backfill of historical audit records writes `created_at` in the past and needs that month's partition
to exist. Create it explicitly with `app.create_audit_log_partitions('<month>')` before importing — the
maintenance job only looks forward. Note there is no `updated_at` on this table, so the timestamp trap
the attendance runbook warns about does not apply here.

Backdating `created_at` is only appropriate when reconstructing history from an authoritative source. It
is never appropriate for ordinary late entry: an audit row's `created_at` is _when the event was
recorded_, and rewriting it is exactly the kind of history-editing this table exists to make impossible.

### Future-dated records

Same rule in the other direction. The maintenance job keeps at least three months of headroom, so
ordinary writes are safe. An audit row should essentially never be future-dated; if one is, treat it as a
clock or application bug rather than creating a partition for it.

### Year boundary

Nothing special happens in December. The names roll from `audit_logs_y2026m12` to `audit_logs_y2027m01`
and the bounds from `('2026-12-01…') TO ('2027-01-01…')` to `('2027-01-01…') TO ('2027-02-01…')`. As long
as the job keeps three months ahead, the boundary needs no attention.

## Monitoring and alerting

Recommended:

- **Alert on the maintenance job failing.** It exits non-zero; a silent failure is the only way this
  system degrades badly, because the symptom (failed writes) arrives up to three months later.
- **Alert on the partition horizon**, not just on the job. The job succeeding is not the same as the
  horizon being adequate. Alert when the furthest future partition is less than ~60 days away.
- **Alert on any insert failing with SQLSTATE `23514` / "no partition of relation"** — that is the
  missing-partition failure, and it means maintenance has already been broken for a while. For the audit
  log this is more urgent than for attendance: if audit rows are written in the same transaction as the
  change they record, a missing partition takes down the write path it audits.
- **Alert on `42501` / "audit_logs is append-only"**. Under normal operation this error is impossible —
  the application has no `UPDATE` or `DELETE` grant to attempt with. Seeing it means something is trying
  to rewrite the audit log, and that is worth waking someone for.
- **Audit the grants on a schedule**, using the verification query above. `app_update` or `app_delete`
  returning `true` on any partition is a security incident.
- Track partition count and per-partition row count/size so growth is visible before it is a problem.
  Audit logs grow faster than most teams expect.

## Retention

**Nothing is dropped automatically. `app.create_audit_log_partitions` and
`app.ensure_audit_log_partitions` only ever create.**

This is deliberate and out of scope for ST-046. How long an audit trail must be kept is a legal and
contractual question (data-protection rules, per-jurisdiction record-keeping obligations, per-school
contracts, and any compliance regime the product is certified against), not an engineering default.
Inventing a schedule here would risk destroying records the platform is legally required to hold — and an
audit log is precisely the artifact an auditor or a regulator asks for after the window in which anyone
thought to keep it.

Before any retention policy is implemented, the following must be decided by whoever owns data retention
for the product, not by this ticket:

- the retention period, and whether it varies by jurisdiction or by school;
- whether expired data is archived (detach + export) or destroyed;
- how backups interact — a dropped partition still lives in backups and PITR until those expire;
- whether an archived partition must remain queryable;
- whether a per-school erasure request (GDPR-style) can reach the audit log at all, or whether the
  legitimate-interest basis for keeping a security audit trail overrides it. This one is a legal
  question, and it is the reason the append-only trigger blocks row deletion outright rather than
  leaving a convenient hole.

When that policy exists, the mechanism is straightforward and should be a separate ticket:
`ALTER TABLE … DETACH PARTITION` (which is not destructive), export, then drop. Detaching is the safe
first step and is reversible; dropping is not.

## Benchmark procedure

To re-measure the 100-log batch target:

```
docker compose -f db/compose.yml up -d --wait
AUDIT_LOGS_BENCHMARK=1 TEST_DATABASE_URL=postgresql://… \
  bun test tests/audit-logs-benchmark.test.ts   # in packages/db
```

It prints the database's own mean execution time and the end-to-end min/median/p95/max, and asserts both
against the 20 ms target. Recorded results, the environment they were taken in, and where the time
actually goes are in [audit logs](audit-logs-data-model.md#batch-append-benchmark). Note the
client-measured number includes one network round-trip: run it on a quiet machine, or the tail will
mislead you.

## Known limitations

- Production scheduling is not deployed. The signed-image command and CI verification exist, but an
  in-VPC ECS/EventBridge schedule remains an explicit infrastructure follow-up — shared with attendance.
- Queries not bounded by `created_at` scan every partition. This is inherent to range partitioning, not a
  defect; see the pruning guide in the data-model doc.
- `id` is not enforced unique across partitions. See
  [the uniqueness limitation](audit-logs-data-model.md#the-uniqueness-limitation).
- Detaching or dropping a partition is a manual, human-reviewed operation by design.
