# Suspected cross-tenant incident (SEV1)

A school's data is visible to users of another school, or writes intended for one school are landing
in another's slice. This is the highest-severity operational incident class in this repo: every row
in every `app.*` table is scoped by `school_id` through `FORCE ROW LEVEL SECURITY`, and a failure
to enforce that boundary affects the fundamental business property ("school A cannot see school B's
data") — which is also a contractual obligation. Every cross-tenant claim in the NFR-05 security
probe
([`apps/api/tests/security/cross-tenant.test.ts`](../../apps/api/tests/security/cross-tenant.test.ts))
is a direct response to this scenario.

**Runbook-style, not policy.** This doc runs; `docs/architecture/SAD_30_backup_policy.md` (if it
covers cross-tenant) states _what_ is acceptable. If the two disagree, the policy wins.

## How RLS works (the mechanism this incident violates)

Two migrations create the mechanism: `000006_create_rls_helper.sql` (the helper function) and
`000012_create_attendance_tables_with_partitioning.sql` (its partitioned-table counterpart).
Every `app.*` table gets:

```sql
ALTER TABLE app.<table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.<table> FORCE ROW LEVEL SECURITY;   -- subjects even studafy_admin (the table owner)
CREATE POLICY <table>_tenant_policy ON app.<table>
  USING     (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK(school_id = current_setting('app.school_id')::uuid);
```

`FORCE ROW LEVEL SECURITY` is what makes this complete: it subjects _even the table owner_
(`studafy_admin`, the connection behind PgBouncer) to the policy — a bare `SELECT * FROM
app.outbox_events` without `SET LOCAL app.school_id` returns zero rows, not every school's events.
The GUC is set per-transaction (`SET LOCAL app.school_id = '<uuid>'`), not per-session, which
makes PgBouncer transaction pooling safe (no session state leaks across pooled connections).

**The five known failure shapes that break this:**

1. **RLS policy dropped or disabled** — a `DROP POLICY` or `ALTER TABLE DISABLE ROW LEVEL SECURITY`
   in a migration, or a direct `psql` command. The CI `test:security` job's `auditRlsCoverage`
   catches this in the repo; a manual DDL in the database bypasses the repo entirely.
2. **Application code skips the `school_id` GUC** — a query path that doesn't set the GUC before
   writing/reading. The `poolIsolation` probe in the same test suite catches a stale-GUC leak.
3. **Application code passes the wrong `schoolId`** — the GUC is set, but to the wrong value; RLS
   works as designed and hides the wrong data. This is the hardest shape to detect automatically —
   the policy is enforced, the query returns the "right" (but semantically wrong) rows.
4. **Trigger prevents `school_id` mutation** — an `UPDATE SET school_id = ...` on a row is blocked
   by `SQLSTATE 42501` (the trigger on every table that forbids ownership transfer). An attacker
   trying to move a row from school A to school B gets a clean, expected rejection — but the probe
   tests this as a positive "the trigger works," not as an incident.
5. **PgBouncer session leak** — a GUC set in one transaction persists into the next transaction on
   the same pooled connection. The `poolIsolation` probe tests against this with 32 concurrent
   transactions (see `CONCURRENCY` constant); PgBouncer's `server_reset_query_always = 1` clears
   session state on release.

## Detection

- **Direct user report.** A school administrator sees another school's students/grades/attendance in
  their view, or a student sees another class's data. This is currently the most likely detection
  path — the only automated, real-time signal is the `test:security` suite run in CI, not at
  runtime.
- **Audit log anomaly.** `app.audit_logs` carries `school_id` on every row (RLS-enforced). A
  cross-tenant write that slips past RLS would leave audit rows in the wrong school's slice — but
  that assumes audit logging itself hasn't been bypassed. The audit log's write path uses the same
  GUC.
- **The NFR-05 probe's index-plan assertion failing in CI.** A regression in the migration suite
  that drops a tenant-scoped index makes a tenant-filtered query fall back to sequential scan —
  the probe's `enable_seqscan = off` check surfaces this as `index_plan_regression` in CI before
  prod, not after.

## Severity: SEV1

Standard DR roles from `docs/runbooks/dr/README.md`:

| Role                    | Holder at declaration                  |
| ----------------------- | -------------------------------------- |
| Incident commander (IC) | Whoever opens the issue first          |
| Data-plane operator     | The DBA or infra-ticket assignee       |
| Comms lead              | IC unless the scope warrants splitting |

**Comms:** Use the DR README's templates exactly. Open a GitHub issue immediately, label
`dr-incident cross-tenant`, post the initial notification within 15 minutes of detection.

## Decision points

1. **Confirmed cross-tenant, or suspected-but-unconfirmed?** The difference matters for step 2:
   _confirmed_ means you have concrete evidence (a user seeing another school's data, an audit log
   entry in the wrong school's slice); _suspected_ means a user report that could be a UI caching
   bug, a permission-matrix error, or a misunderstanding. Both are treated as SEV1 until ruled out;
   the difference is the urgency of step 2's DB lockdown.
2. **Read or write?** A cross-tenant _read_ (school A sees school B's data) vs. a cross-tenant
   _write_ (school A mutated school B's data) — both are SEV1, but the write requires a forensic
   recovery step the read doesn't.
3. **Root cause: policy gone, GUC wrong, or code path wrong?** The three shapes above each have a
   different fix. The evidence points: `pg_policies` (shape 1), application logs showing the GUC
   value (shape 2/3), or the specific mutation (shape 3).

## Procedure

**1. Preserve evidence immediately (do not reboot anything).**

```bash
# 1a. Audit the current RLS state for every app.* table
# (from the bastion, as studafy_admin, per postgres-conventions.md):
SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies WHERE schemaname = 'app'
ORDER BY tablename, policyname;

# 1b. Confirm ENABLE/FORCE is correct everywhere
SELECT tablename, rowsecurity, forcerowsecurity
FROM pg_tables WHERE schemaname = 'app'
ORDER BY tablename;

# 1c. Pull the current app.* table list from the information schema for
# a comparison against the test:security probe's known set
SELECT tablename FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename;
```

The cross-tenant test's `auditRlsCoverage` function (imported from `db/policies/rls-coverage`) is
the source of truth for which table _should_ have RLS. Compare its expected set against the
`pg_tables` output above; a table in the set but not in `pg_policies` (or with `rowsecurity=false`)
is the smoking gun, not an indicator.

**2. Contain.** If the breach is a _write_, lock the database to inbound writes from the
application while the forensic investigation runs. Do **not** reboot the instances or restart
PgBouncer — that destroys connection state and the evidence of which pool connection handled the
offending transaction:

```sql
-- Option A (least destructive): revoke write access for the application role
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app FROM studafy_admin;
-- Option B (more destructive): set the database to read-only
ALTER DATABASE <db> SET default_transaction_read_only = ON;
```

Option A is the normal choice — it stops new cross-tenant writes without affecting the API's read
path (which is the most common detection signal, since reads continue to work). If the incident is
a _read_ only, containment can be a targeted revoke on the specific table(s) involved rather than
all writes.

**3. Identify the source of the cross-tenant access.**

```sql
-- Current GUCs on active transactions (if a leak is suspected):
SELECT pid, usename, query, query_start,
       current_setting('app.school_id', true) AS school_id
FROM pg_stat_activity
WHERE datname = current_database()
  AND query NOT ILIKE '%pg_stat_activity%';

-- Review recent write history in the audit log
SELECT id, school_id, actor_id, event_type, created_at
FROM app.audit_logs
WHERE created_at > now() - interval '1 hour'
ORDER BY created_at DESC LIMIT 50;
```

A `school_id` on an `audit_logs` row that doesn't match the expected school for that `actor_id`
is the write-path smoking gun. A missing `school_id` GUC (`current_setting('app.school_id', true)`
returns empty) is the GUC-leak smoking gun.

**4. Fix the root cause.**

| Root cause                                | Fix                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RLS policy missing/dropped                | `CREATE POLICY` re-adding it (same statement as the migration), then re-run the `test:security` probe locally to confirm.                                                            |
| Wrong `school_id` GUC in application code | Identify the code path, fix, deploy via `deploy-rollback.md`.                                                                                                                        |
| PgBouncer session leak                    | Verify `server_reset_query_always = 1` on the PgBouncer config; if present, this is an application-layer leak, not a PgBouncer one — look for a connection held across transactions. |
| Manual DDL bypassed the repo              | Revoke the manual DDL permission (`REVOKE CREATE ON SCHEMA app FROM studafy_admin`), then add the missing policy via a new migration.                                                |

**5. Verify isolation is restored.**

Run the NFR-05 cross-tenant security probe against the _production_ database (it reads `DATABASE_URL`
from the environment, so it can be pointed at any Postgres instance):

```bash
# From the bastion, or via a one-off ECS task pointed at prod:
TEST_DATABASE_URL="postgresql://studafy_test:<password>@<pgbouncer-host>:<port>/studafy_prod?sslmode=require" \
DATABASE_SSL_MODE=require \
bun run test:security --cwd apps/api
```

This runs the five-part NFR-05 probe (RLS coverage audit, cross-tenant CRUD, normalization attack,
pool isolation, index plan regression) against the live database. Every part must pass. A failure
here after a fix means the fix didn't land.

**6. If cross-tenant _writes_ occurred, recover or contain the data.** A write into school B's
slice from school A's context is already committed — RLS is enforced on access, not logged as a
prevention event. Two options, neither clean:

- **Point-in-time recovery to before the bad write** — same mechanism as
  `docs/runbooks/dr/postgres-instance-loss.md`, but scoped to one school. This rolls back _every_
  school's writes after that timestamp, not just the offending one — an unacceptable trade-off
  unless the window is very short. Document the RTO.
- **Targeted deletion** — if the offending rows are known and identifiable (from the audit log),
  delete them surgically. This is faster but means trusting the forensic completeness of the audit
  log, which is itself audit-protected.

Record the chosen recovery path in the issue.

**7. Close the loop.** Post the DR README's resolution template in the issue, name the
follow-up tickets (RLS policy gap, code path fix, probe gap), and re-run the `test:security` suite
on `main` after the fix merges — it should go green; if it was already green before the fix, the
root cause was not the path the probe covers (shape 2 or 3 above), and the fix should be followed
by an expanded probe.

## Rollback / abort criteria

Abort the procedure at step 2 if the forensic investigation (step 3) reveals the breach is _not_
cross-tenant — a different access control bug (role/permission, not RLS) needs a different
containment. Do not revoke writes on a `SELECT`-only incident without understanding the blast
radius first.

If the `test:security` probe fails in step 5 after a policy re-creation, do not re-deploy — stop,
read the diagnostic output (the probe logs exactly which table and which check failed), and
escalate: the RLS enforcement mechanism itself may be misconfigured at the instance level, not
just a missing policy.

## Known gaps

- **No runtime detection.** The `test:security` suite is a CI gate; there is no real-time
  "cross-tenant access attempted" CloudWatch metric or alarm. A runtime probe (a synthetic
  cross-tenant query on a schedule, or an audit of `app.audit_logs` for school_id mismatches) is
  future work. This is the honest reason the detection section above starts with "user report."
- **No write-scoped recovery tool.** `postgres-instance-loss.md`'s PITR restore recovers the
  whole instance; a school-scoped undo of cross-tenant writes is a manual SQL exercise, not a
  runbook-automated one. A targeted "undo school X's writes in window Y" tool is future work.
- **The `poolIsolation` probe's concurrency constant is tuned to the local test harness.**
  `CONCURRENCY = 32` and `POOL_SIZE = 4` match the CI runner's pool config; a production pool
  with a larger `max` means more concurrent transactions are possible, which is exactly the scenario
  where a session leak surfaces. The test is still a useful ceiling; it's not an exhaustive one.

## Tabletop exercise

The paper drill for this runbook — injections, decision points, expected actions, pass/fail
criteria, debrief checklist — is [`dr/cross-tenant-tabletop-exercise.md`](dr/cross-tenant-tabletop-exercise.md).
The acceptance criterion "SEV1 cross-tenant runbook tabletop-tested" is **not met** until a drill
report there records a conduction; this runbook will not claim otherwise.
