# Migration failure

A database migration fails during a deploy. Production has one deploy path,
**Production deploy (fly.io)** (`.github/workflows/fly-production-deploy.yml`, `workflow_dispatch`
only), and its "Run database migrations" step runs the migrations as a one-off fly machine in the
`studafy-core-migrate` app before any service is deployed. A non-zero exit fails that step and the
run stops there — nothing is released. This runbook is what a responder does with that failed run.

Mechanism source: [`.github/workflows/fly-production-deploy.yml`](../../.github/workflows/fly-production-deploy.yml),
[`infra/fly/migrate.toml`](../../infra/fly/migrate.toml),
[`packages/db/src/runner.ts`](../../packages/db/src/runner.ts),
[`packages/db/src/errors.ts`](../../packages/db/src/errors.ts),
[`db/migrations/`](../../db/migrations/). Deploy context and how the database is reached:
[`infra/fly/README.md`](../../infra/fly/README.md) ("Deploying", "Database connections").

## Detection

The failed workflow run is the alert: the step ends with `Migrations exited with <code>; nothing
was released.` (or `The migration machine never launched`). The workflow opens no issue and there
is no paging channel in this repo; GitHub's own failed-run notification reaches whoever dispatched
it. Open a GitHub issue (label `deploy-failure`) linking the run if more than one person needs to
see it.

The migration machine connects **directly** to Supabase (`db.<project ref>.supabase.co:5432`, user
`postgres`), not through the pooler (`infra/fly/migrate.toml`). The step prints the machine's logs
(`flyctl logs --app studafy-core-migrate --machine <id>`) and then destroys the machine, so the
run log is where the failure is read.

## Why the migration gate is what it is

The migration step runs before any `flyctl deploy` of a service, and its non-zero exit halts the
run. Three failure shapes inside the machine must be told apart
before anything else, because they have different answers:

1. **A statement in a migration file failed** — `MigrationExecutionError` from `applyMigration` in
   `runner.ts` (`<filename> failed: <message>`). The failure is inside one migration's own SQL.
2. **The advisory lock was already held** — `MigrationLockError`, "Another migration process holds
   the Studafy advisory lock". Either a previous migration machine is still running, or one was
   killed **after** acquiring the lock (a held-but-orphaned lock only clears when the session
   holding it ends — a lost session releases its PostgreSQL advisory lock automatically, but only
   once Postgres notices the connection is gone).
3. **Checksum/rename/order validation failed** — `MigrationValidationError`. An applied migration
   was edited, renamed, or a new migration is older than one already applied. This is a repo
   hygiene bug, not an environment problem.

The migration runner is **forward-only** — command set is `migrate|status|validate|pending|seed`
(`packages/db/src/cli.ts`), and every migration is expected to stay backward-compatible with code
it might run under. There is no "down" command to reach for, and no rollback procedure is
defined for fly yet: schema changes are never rolled back.

## Decision points

1. **Which failure shape?** Read the migration machine's log in the failed run.
   Lock-vs-statement-vs-validation divide the world as above; the procedure differs from step 2 on.
2. **Is the failure in a _new, in-flight_ migration or a drift problem?** There is no staging
   environment; a migration that passed CI's `database-migrations` job but fails in production is
   usually drift (production's schema ahead/behind of the code the image carries) or a Supabase
   difference (`infra/fly/README.md`'s "Where Supabase differs from RDS"). One that also fails
   locally is a bug in the migration itself.
3. **Can the deploy continue with the migration deferred?** Sometimes yes — a rollback target
   doesn't need the new column. Decide _before_ hand-running anything, and say the decision in the
   issue, so a second responder doesn't race you.

## Procedure

**1. Confirm the gate actually halted (nothing deployed).** In the failed run, every step after
"Run database migrations" is skipped. The services are still on their previous release:

```bash
fly releases --app studafy-core-api | head -3
```

If a service _did_ change, the failure wasn't the migration gate.

**2. Read the failure.** The "Run database migrations" step's log shows the machine's output
followed by `Migrations exited with <code>`; match the error against the three runner errors
above. If the run died before printing logs, the machine may still exist:

```bash
fly machine list --app studafy-core-migrate
fly logs --app studafy-core-migrate --no-tail
```

**3a. Statement failure → fix the migration, not the environment.**

The migration file is immutable once applied anywhere (`validateHistory` checksums it). If it
failed _and_ was never applied (no `schema_migrations` row for it), fix the SQL and land a new,
later-versioned migration — do not edit the failed file; if another environment already applied
the old checksum, editing it puts every later `validate` into `MigrationValidationError`.

```bash
# Confirm no row was recorded (a transactional migration rolls back with its failure,
# so this is the expected state):
# SELECT version, name FROM public.schema_migrations ORDER BY version DESC LIMIT 3;
```

Then merge the fix and run **Production deploy (fly.io)** again on the fixed ref. The migration
machine re-runs from a freshly built image.

**3b. Lock error → find the holder, or wait it out.**

```sql
-- Supabase SQL editor, or a direct connection (db.<project ref>.supabase.co:5432):
SELECT pid, state, query_start, now() - query_start AS age, query
FROM pg_stat_activity
WHERE query ILIKE '%6004517954832980272%'      -- ADVISORY_LOCK_KEY (packages/db/src/runner.ts)
   OR wait_event_type = 'Lock';
```

A live second migration machine is the usual suspect (`fly machine list --app
studafy-core-migrate`) — a workflow rerun while the original still ran. The workflow's concurrency
group (`fly-production`) queues a second run rather than overlapping, so this mostly follows a
hand-run `fly machine run`. Either let the earlier machine finish (wait, then re-dispatch) or stop
it deliberately. An _orphaned_ lock from a killed machine clears automatically once Postgres reaps the dead session; if `pg_stat_activity` shows
nothing holding it, the lock is gone and the original failure was something else — re-run the
advisory-lock step (`SELECT pg_try_advisory_lock(...)`) to prove it's free before re-dispatching.

**3c. Validation error → never a re-run; fix the repo.**

`MigrationValidationError` means an applied migration's file diverged from what ran (renamed,
edited, or out-of-order pending). Re-running the machine reproduces the same validation failure —
this is a code review / history fix, not an operational one. The deploy stays halted until the
repo is corrected; record the offending file in the issue.

**4. Decide the deploy's fate.** Options, in order of preference:

- **Fix and re-dispatch** (steps 3a/3b paths) — the deploy completes on a corrected image.
- **Merge-reviewed explicit skip** — for a migration that is _known_ not to be required by the
  rolled-back code (the rollback target predates it): note the decision in the issue, re-dispatch
  is _not_ possible without the migration succeeding, so this path means _deferring_ the release
  and leaving the failed run halted, not "deploy without the migration". There is no skip flag in
  the tooling — removing the file from the image is the only way the gate lets a deploy through,
  and that is a deliberate, reviewed change, not a build trick.
- **Escalate** — if the migration intersects the schema in a way that requires data repair
  (a backfill that partially applied before a non-transactional migration failed), stop here and
  involve the schema owner. Non-transactional migrations (`transactional: false` — declared in
  `packages/db/src/discovery.ts` / migration headers) can leave partial effects; a re-run must
  assume that and be idempotent or reviewed for it.

**5. Close the loop.** A successful re-deploy ends with the workflow's smoke check passing; if the
deploy stays halted, leave the issue open with the decision from step 4 and the follow-up ticket
links — don't close it silently.

## Rollback / abort criteria

Abort the _procedure_ (not the deploy) the moment a second responder starts racing the same fix —
hand the issue over, don't both edit migrations. If step 3c is the verdict, stop entirely: no
environment-side action makes a validation error go away.

## Known gaps

- No automated detection distinguishes the three failure shapes — the log triage in step 2 is
  manual. A step that greps the migration machine's log for the three error classes and
  labels the issue accordingly is future work.
- A non-transactional migration that partially applied and then failed has no automated "where did
  it stop" report — `db:migrate` re-runs the file from the top each time, and the file is assumed
  idempotent; that assumption should be tested per non-transactional migration, not trusted.
- There is no "deploy without this migration" affordance at all (no skip flag, no env toggle).
  Deferring a release is currently the only halt-consistent option, which is honest but coarse.
- A failed migration opens no issue automatically; the failed workflow run is the only signal.
