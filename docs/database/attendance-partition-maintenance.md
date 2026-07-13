# Attendance partition maintenance

Operational runbook for the monthly partitions of `app.attendance_sessions` and
`app.attendance_records`. The data model itself is documented in [attendance](attendance.md).

## Overview

|                     |                                                                                 |
| ------------------- | ------------------------------------------------------------------------------- |
| Parent tables       | `app.attendance_sessions`, `app.attendance_records`                             |
| Partitioning        | declarative `PARTITION BY RANGE (created_at)`, one partition per calendar month |
| Partition names     | `attendance_sessions_y2026m07`, `attendance_records_y2026m07`                   |
| Boundaries          | half-open, UTC: `FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00')` |
| Default partition   | none, deliberately                                                              |
| Initial range       | 2026-06 through 2027-01, created by migration `000012`                          |
| Maintenance command | `bun run db:attendance:partitions [months-ahead]` (default 3)                   |
| Required role       | the administrative/migration identity; the command runs as `studafy_admin`      |
| Retention           | out of scope — nothing is ever dropped automatically                            |

Attendance is the highest-volume table in the product. Monthly partitioning keeps vacuum, index
maintenance, and history queries bounded, and makes an eventual archive strategy a metadata operation
rather than a mass delete.

### Partition key vs business date

`created_at` is the partition key: when the row was written. `session_date` is the educational date the
attendance is _for_. They are not the same and neither is derived from the other. A session for
2026-09-14 that is imported in October is stored in **October's** partition. Consequently a query
filtered only by `session_date` cannot prune partitions; see [attendance](attendance.md).

### Timezone

Month boundaries are UTC. `app.create_attendance_partitions` pins `timezone = 'UTC'` for the duration
of the call, so a partition's bounds never depend on the server's or the caller's `TimeZone` setting.
Local school time zones deliberately do not affect physical partition boundaries — they are a business
concern, expressed by `session_date`.

## The maintenance command

```
bun run db:attendance:partitions        # ensure current month + 3 months ahead
bun run db:attendance:partitions 6      # ensure current month + 6 months ahead
```

It reads the same configuration as the migration runner (`DATABASE_URL`, or the discrete
`DATABASE_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD`, plus `DATABASE_SSL_MODE`), takes the migration
runner's advisory lock so maintenance cannot race either another maintenance run or a schema
migration, executes `SET LOCAL ROLE studafy_admin`, and calls
`app.ensure_attendance_partitions(months_ahead)`.

It prints the partitions it created and then every attendance partition with its bounds. It never
prints credentials; any error is passed through the same redaction the migration runner uses. Exit code
is `0` on success, `1` on failure, `2` on a usage error — so a scheduler will notice a failure.

The command is **idempotent**. A month whose partitions already exist with matching bounds is skipped.
A relation squatting on a partition name with different bounds, or that is not a partition of the
expected parent, raises rather than being silently altered — rewriting a live partition's bounds would
either lose rows or fail halfway.

Underneath are two functions, both owned by `studafy_admin`, both revoked from `PUBLIC` and
`studafy_app`:

```sql
app.create_attendance_partitions(target_month date) RETURNS text[]
app.ensure_attendance_partitions(months_ahead integer DEFAULT 3) RETURNS text[]
```

### Recommended schedule

Run **weekly**, keeping at least **3 months** of headroom, from an in-VPC ECS/EventBridge task using
the signed migrations image and its existing Secrets Manager-backed administrative identity. The
image's normal entry point is the database CLI, so the task command override is:

```text
attendance-partitions 3
```

ST-040 packages and verifies that command, but it does **not** deploy the EventBridge schedule. A
GitHub-hosted cron was deliberately rejected: hosted runners cannot reach the private database, and
putting a directly reachable administrative `DATABASE_URL` in GitHub would conflict with the
repository's Secrets Manager and VPC conventions. Until an in-VPC scheduler is provisioned, run the
command as a one-off migrations task during deployment or by an operator with approved connectivity.

A database first migrated long after 2027-01 has no usable attendance partition until the maintenance
command has run at least once, and attendance inserts will fail loudly (see below) until it does. The
command is safe to run immediately after `db:migrate`, and CI does exactly that.

## Verifying

List the partitions and their bounds:

```sql
SELECT parent.relname AS parent,
       child.relname  AS partition,
       pg_get_expr(child.relpartbound, child.oid) AS bounds
FROM pg_inherits AS i
JOIN pg_class AS child  ON child.oid  = i.inhrelid
JOIN pg_class AS parent ON parent.oid = i.inhparent
JOIN pg_namespace AS ns ON ns.oid = parent.relnamespace
WHERE ns.nspname = 'app'
  AND parent.relname IN ('attendance_sessions', 'attendance_records')
ORDER BY parent.relname, child.relname;
```

Confirm a new partition's security matches the parent — owner, forced RLS, canonical policy, grants:

```sql
SELECT c.relname,
       pg_get_userbyid(c.relowner)      AS owner,        -- must be studafy_admin
       c.relrowsecurity                 AS rls,          -- must be true
       c.relforcerowsecurity            AS forced,       -- must be true
       (SELECT count(*) FROM pg_policy p
         WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,  -- must be 1
       has_table_privilege('public', c.oid, 'SELECT')    AS public_can_read       -- must be false
FROM pg_class AS c
JOIN pg_namespace AS ns ON ns.oid = c.relnamespace
WHERE ns.nspname = 'app' AND c.relname LIKE 'attendance\_%y%m%';
```

Confirm the parent's indexes propagated to it:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE indrelid = 'app.attendance_records_y2026m07'::regclass;
```

Confirm a row routed to the partition you expect:

```sql
SELECT tableoid::regclass, id, created_at FROM app.attendance_sessions WHERE id = '…';
```

Confirm no row is stranded in a parent (there should never be any):

```sql
SELECT count(*) FROM ONLY app.attendance_sessions;
SELECT count(*) FROM ONLY app.attendance_records;
```

## How new partitions inherit security

`app.create_attendance_partitions` does all of this at creation time, so no manual security step is
ever required and none can be forgotten:

- **Owner** — the partition is created while the session is `studafy_admin`, so `studafy_admin` owns it.
- **Grants** — `REVOKE ALL … FROM PUBLIC`, then `GRANT SELECT, INSERT, UPDATE, DELETE … TO studafy_app`.
- **RLS** — `app.apply_tenant_isolation('app', <partition>)` enables **and forces** RLS and installs the
  canonical `tenant_isolation` policy.
- **Indexes** — not created here. Indexes are declared on the partitioned parent, and PostgreSQL creates
  the partition-local index automatically when the partition is attached.

This is not optional bookkeeping. **RLS does not cascade.** Enabling RLS on a partitioned parent does
not recurse to its partitions, and the parent's policy is not consulted when a partition is queried
directly. `studafy_app` can name a partition directly, so a partition without its own forced policy
would be a tenant-isolation hole. The test suite asserts every partition — including one created after
the migration, by this function — carries the same owner, grants, forced RLS and policy as the parent.

## Failure modes

### Missing partition

Symptom, on insert:

```
ERROR: no partition of relation "attendance_sessions" found for row
DETAIL: Partition key of the failing row contains (created_at) = (2030-05-10 09:00:00+00).
```

This is the intended behaviour. There is **no `DEFAULT` partition**, on purpose: a default partition
would silently absorb rows for a month whose maintenance had failed, turning a loud and immediately
fixable error into an unbounded heap discovered months later, with no way to move the rows out without
downtime.

Recovery — create the month and retry. The failed insert has no side effects:

```
bun run db:attendance:partitions
```

or, for one specific month (as the administrative identity):

```sql
SET ROLE studafy_admin;
SELECT app.create_attendance_partitions('2030-05-01');
RESET ROLE;
```

Then verify security on the new partition with the query above. Do **not** create the partition by hand
with `CREATE TABLE … PARTITION OF …`: that skips the grants and the forced RLS policy, leaving the
partition readable across tenants. If you truly must, run
`SELECT app.apply_tenant_isolation('app', '<partition>')` and the `REVOKE`/`GRANT` immediately
afterwards, in the same transaction.

### Backdated imports

A backdated import writes `created_at` in the past and needs that historical month's partition to
exist. Create it explicitly with `app.create_attendance_partitions('<month>')` before importing — the
maintenance job only looks forward. Remember that the business date is `session_date` and is
independent: importing September's attendance in October is normal and correct, and those rows belong
in October's partition. Backdating `created_at` is only appropriate when reconstructing history, not
for ordinary late entry.

Note that a row written with an explicit `created_at` must also set `updated_at`: the
`ck_attendance_*_timestamps` constraint requires `updated_at >= created_at`, and a defaulted
`updated_at` of "now" is earlier than a future-dated `created_at`.

### Future-dated records

Same rule in the other direction. The maintenance job keeps at least three months of headroom, so
ordinary writes are safe; a record dated beyond the horizon needs its month created first.

### Year boundary

Nothing special happens in December. The names roll from `…_y2026m12` to `…_y2027m01` and the bounds
from `('2026-12-01…') TO ('2027-01-01…')` to `('2027-01-01…') TO ('2027-02-01…')`. The December→January
and leap-year February transitions are covered by tests. As long as the job keeps three months ahead,
the boundary needs no attention.

## Monitoring and alerting

Recommended:

- **Alert on the maintenance job failing.** It exits non-zero; a silent failure is the only way this
  system degrades badly, because the symptom (failed inserts) arrives up to three months later.
- **Alert on the partition horizon**, not just on the job. The job succeeding is not the same as the
  horizon being adequate. Alert when the furthest future partition is less than ~60 days away:

  ```sql
  SELECT max(substring(child.relname FROM 'y(\d{4})m(\d{2})$')) FROM …
  ```

  or more simply, alert if inserting into the next month would fail.

- **Alert on any insert failing with SQLSTATE `23514` / "no partition of relation"** — that is the
  missing-partition failure, and it means maintenance has already been broken for a while.
- Track partition count and per-partition row count/size so growth is visible before it is a problem.

## Retention

**Nothing is dropped automatically. `app.create_attendance_partitions` and
`app.ensure_attendance_partitions` only ever create.**

This is deliberate and out of scope for ST-040. Attendance is a student record: how long it must be
kept is a legal and contractual question (education-records retention, per-jurisdiction data-protection
rules, and per-school contracts), not an engineering default. Inventing a schedule here would risk
destroying records a school is legally required to hold, and an automated `DROP TABLE` on a partition is
irreversible in a way a migration is not.

Before any retention policy is implemented, the following must be decided by whoever owns data
retention for the product, not by this ticket:

- the retention period, and whether it varies by jurisdiction or by school;
- whether expired data is archived (detach + export) or destroyed;
- how backups interact — a dropped partition still lives in backups and PITR until those expire;
- whether an archived partition must remain queryable.

When that policy exists, the mechanism is straightforward and should be a separate ticket:
`ALTER TABLE … DETACH PARTITION` (which is not destructive), export, then drop. Detaching is the safe
first step and is reversible; dropping is not.

## Benchmark procedure

To re-measure the 40-record batch target:

```
docker compose -f db/compose.yml up -d --wait
ATTENDANCE_BENCHMARK=1 TEST_DATABASE_URL=postgresql://… \
  bun test tests/attendance-benchmark.test.ts   # in packages/db
```

It prints min/median/p95/max and asserts the median is under 50 ms. Recorded results, the environment
they were taken in, and where the time actually goes are in [attendance](attendance.md#batch-insert-benchmark).
Note the client-measured number is dominated by transaction round-trips, not by the database: run it on
a quiet machine, or the tail will mislead you.

## Known limitations

- Production scheduling is not deployed. The signed-image command and CI verification exist, but an
  in-VPC ECS/EventBridge schedule remains an explicit infrastructure follow-up.
- Queries filtered only by `session_date` scan every partition.
- Detaching or dropping a partition is a manual, human-reviewed operation by design.
