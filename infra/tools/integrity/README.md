# `integrity`

Per-tenant data validation console. Runs a fixed set of read-only integrity checks against one
school's tables on a Postgres instance and writes a JSON report (`integrity-report-<slug>-<runid>.json`)
that can be attached to a support case. `drill-corruption.sh` is a self-verifying drill that proves
every check actually detects the corruption it was built to detect, on a disposable local database.

## What this does

| Piece                           | What it is                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-integrity-check.sh`        | Runs the four checks for one school (`--school-slug` or `--school-id`), writes the report, exits 0 clean / 1 on findings / 2 on usage error.                               |
| `drill-corruption.sh`           | Injects one real violation per check, asserts the console flags all of them with findings, undoes them, re-runs, and requires a clean result. Local-only + superuser-only. |
| `lib/common.sh`                 | Connection resolution (same dual AWS/direct mode as `infra/tools/tenant-restore`), school/admin resolution, capability probes.                                             |
| `lib/checks/*.sql`              | `01-orphaned-links.sql`, `02-enrollment-invoice-consistency.sql`, `03-grade-weight-sums.sql`, `04-rls-catalog.sql` (catalogue sub-probe).                                  |
| `lib/checks/rls-spot-probes.sh` | Behavioural RLS probes (`SET ROLE studafy_app`), aggregated into the `rls-spot-probes` check together with `04`.                                                           |

Every check emits exactly one JSON line to stdout:
`{check, status: "pass"|"fail"|"error", findings_count, findings[] (capped at 100 rows,
findings_count is the total), summary, duration_s}`. `findings_count` is the true total even when
only 100 are embedded.

## Checks

- **orphaned-links** — a catalogue-driven scan of _every_ foreign key whose child table is a
  tenant-scoped `app.*` table (a row with a `school_id` column, referenced side not partitioned),
  joined per the constraint's own key columns and scoped to this school. Any row whose reference is
  missing — or belongs to a different school — is a finding, flagged with whether the constraint was
  `convalidated`. A validated FK can only be violated by writes that bypass enforcement (e.g.
  `session_replication_role = replica`), which is exactly what the drill does. Also checks the
  `app.erpnext_id_mappings` crosswalk: a mapping with a confirmed `erpnext_docname` must still have
  its target `invoice_cache`/`payment_cache`/`fee_schedule_cache` row (`docname IS NULL` rows are
  pre-confirmation reservations and are never findings).
- **enrollment-invoice-consistency** — every invoice and every payment for this school must belong
  to a student who has at least one enrollment row in the school (any status), and every paid
  student must have at least one invoice. "Enrolled but not yet invoiced" is deliberately **not** a
  finding (the demo seed invoices only 4 of 8 students).
- **grade-weight-sums** — the active `app.assessment_categories` of each gradebook must weigh to
  exactly 100 (the invariant `INVALID_GRADEBOOK_WEIGHT_TOTAL` enforces in the application layer).
  Gradebooks with no active categories vacuously pass.
- **rls-spot-probes** — four sub-probes on `students`, `enrollments`, `invoice_cache`, `grades`
  (+ catalogue coverage of `gradebooks`, `grade_submissions`):
  1. fail-closed: reading as `studafy_app` with **no** `app.school_id` GUC must raise
     `unrecognized configuration parameter "app.school_id"` — returning rows means RLS is not
     filtering tenant reads;
  2. a nonexistent `app.school_id` must yield zero rows;
  3. with the real `app.school_id` **and** a real `ORG_ADMIN`/`SUPER_ADMIN` `app.user_id`,
     `studafy_app` must count exactly what an explicit `WHERE school_id` count sees;
  4. catalogue: `ROW LEVEL SECURITY` enabled and forced, the canonical permissive
     `tenant_isolation` policy present with the expected expression, and no extra permissive policy.

## Runbook

```bash
# local: compose Postgres (port 54329, superuser studafy_test) already migrated & seeded
bun run db:up && bun run db:migrate && bun run db:seed

# set the same connection the API/tooling uses locally (Infra section of .env, or db/compose.yml)
export PGHOST=127.0.0.1 PGPORT=54329 PGUSER=studafy_test PGPASSWORD=studafy_test PGDATABASE=studafy

./run-integrity-check.sh --school-slug studafy-demo-academy        # -> exit 0, report written
./run-integrity-check.sh --school-id <uuid> --check orphaned-links # one check only
./drill-corruption.sh                                              # -> RESULT: PASS
```

AWS mode is identical to `tenant-restore`'s: set `CONNECTION_SECRET_ARN` + `AWS_REGION` (and
`PGHOST_OVERRIDE` if a scratch instance is the target). Data checks run as the connected role
(superuser locally / RDS master) — they set `app.school_id` via
`SELECT set_config('app.school_id', :'school_id', false)` and filter every query by school_id
explicitly, so a connected role that bypasses RLS still sees exactly one tenant. The RLS probes
additionally `SET ROLE studafy_app`, so the connected role must be able to (probed up front, hard
failure otherwise).

## Report format

```json
{
  "tool": "integrity",
  "run_id": "20260922-121304",
  "started_at": "...",
  "finished_at": "...",
  "host": "127.0.0.1",
  "database": "studafy",
  "school": { "id": "...", "slug": "...", "name": "Studafy Demo Academy" },
  "checks": [
    {
      "check": "orphaned-links",
      "status": "pass",
      "findings_count": 0,
      "findings": [],
      "summary": "...",
      "duration_s": 1
    }
  ],
  "result": "pass"
}
```

## Known gaps

- **RLS-measured visibility is not 100% of a school's rows for every actor.** The correct-GUC
  parity probe compares `studafy_app` + admin actor counts to an explicit `school_id` count. Tables
  with an additional restrictive `role_scope_visibility` policy (migration 000037) resolve their
  admin escape hatch via `app.user_id`, which is why the probe sets a real admin. A table whose
  restrictive policy has _no_ admin escape (like `teacher_evaluations`, seen in `tenant-restore`'s
  known gaps) is not among the probe tables, and this console makes no claim about it.
- **Data checks need a role that can see the whole tenant.** Locally and on RDS the connected role
  is a superuser, which the checks rely on for their baseline reads. A non-superuser connection
  would silently change what the checks can see; the console does not currently detect that (the
  drill does require superuser, separately).
- **This is not a full data-audit.** The four checks cover the documented invariants they were
  built around; nothing here generalizes to "every constraint ever". `convalidated = false` FKs are
  scanned, not re-validated.
- **100-finding cap.** Findings embed is capped at 100 per check; `findings_count` carries the
  true total. For a massively corrupt tenant, count-level truth is on the report.
- **Validation was exercised on the local compose instance** (`bun run db:up` + migrate + seed),
  not against real AWS RDS — consistent with every other module in this repo (see
  `infra/tools/tenant-restore/README.md`). Whether the RDS master credential behaves like a local
  superuser w.r.t. RLS (it is expected to bypass it, the same way a local Docker superuser does)
  has never been confirmed against live infrastructure.
