# Migration failure

A database migration fails during a deploy. Both deploy paths run the same one-off Fargate task
(`infra/deploy/scripts/migrate.sh`): staging on every merge to `main`, prod on
`workflow_dispatch`. A non-zero migration exit halts the pipeline before any service is touched —
this runbook is what a responder does with the `deploy-failure` GitHub issue that halts opens.

Mechanism source: [`infra/deploy/scripts/migrate.sh`](../../infra/deploy/scripts/migrate.sh),
[`packages/db/src/runner.ts`](../../packages/db/src/runner.ts),
[`packages/db/src/errors.ts`](../../packages/db/src/errors.ts),
[`db/migrations/`](../../db/migrations/). Deploy context: `docs/runbooks/deploy-rollback.md`'s
"Migration gate" sections; `docs/runbooks/postgres-conventions.md` for how the instance is reached.

## Detection

The `alert-migration-failed` job in `.github/workflows/staging-deploy.yml` /
`prod-deploy.yml` opens a GitHub issue (label `deploy-failure`) naming the failed run. There is no
paging channel in this repo (see `docs/runbooks/deploy-rollback.md`'s migration-gate note) — the
issue _is_ the alert; the responder is whoever claims it first.

No CloudWatch alarm covers migration failures — they happen inside a deploy pipeline, not against a
live service, so a metric alarm is the wrong surface. A constant failure mode worth knowing:
`exceeded max attempts` / `tasks-stopped` with a non-zero `exitCode` is _normal_ for a failed
migration; the ECS task always exits non-zero by design.

## Why the migration gate is what it is

`migrate.sh` runs before any `deploy.sh` call in both workflows (`needs: migrate` on every deploy
job), and its non-zero exit halts the run. Two failure shapes inside the task must be told apart
before anything else, because they have different answers:

1. **A statement in a migration file failed** — `MigrationExecutionError` from `applyMigration` in
   `runner.ts` (`<filename> failed: <message>`). The failure is inside one migration's own SQL.
2. **The advisory lock was already held** — `MigrationLockError`, "Another migration process holds
   the Studafy advisory lock". Either a previous migration task is still running, or a task was
   killed **after** acquiring the lock (a held-but-orphaned lock only clears when the session
   holding it ends — a lost session releases its PostgreSQL advisory lock automatically, but only
   once Postgres notices the connection is gone).
3. **Checksum/rename/order validation failed** — `MigrationValidationError`. An applied migration
   was edited, renamed, or a new migration is older than one already applied. This is a repo
   hygiene bug, not an environment problem.

The migration runner is **forward-only** — command set is `migrate|status|validate|pending|seed`
(`packages/db/src/cli.ts`), and every migration is expected to stay backward-compatible with code
it might be rolled back under (`docs/runbooks/deploy-rollback.md`'s rollback-scope note). There is
no "down" command to reach for.

## Decision points

1. **Which failure shape?** Read the task's `stoppedReason` and the migration container's log.
   Lock-vs-statement-vs-validation divide the world as above; the procedure differs from step 2 on.
2. **Is the failure in a _new, in-flight_ migration or in one that already applied elsewhere?**
   A migration that applied cleanly in staging but fails in prod is usually drift (prod schema
   ahead/behind of the code the image carries). A migration that fails in staging is usually a bug
   in the migration itself.
3. **Can the deploy continue with the migration deferred?** Sometimes yes — a rollback target
   doesn't need the new column. Decide _before_ hand-running anything, and say the decision in the
   issue, so a second responder doesn't race you.

## Procedure

All commands from the bastion or a role with ECS `DescribeTasks`/`RunTask` + CloudWatch Logs read.

**1. Confirm the gate actually halted (nothing deployed).**

```bash
aws ecs list-tasks --cluster "$ECS_CLUSTER" \
  --service-name studafy-$ENV-api --desired-status RUNNING \
  --query 'taskArns' --output text
```

The deploy jobs never started, so the service is still on its previous task-definition revision.
If a service _did_ change, the failure wasn't the migration gate — see `deploy-rollback.md`, not
this doc.

**2. Read the failure.**

```bash
TASK_ARN="$(aws ecs list-tasks --cluster "$ECS_CLUSTER" \
  --service-name studafy-$ENV-migrations --query 'taskArns[0]' --output text)" # or from the run URL
aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].{lastStatus:lastStatus,stoppedReason:stoppedReason,exitCode:containers[0].exitCode}'
aws logs tail "/studafy-$ENV/ecs/migrations" --since 5m   # awslogs-group from ecs/migrations/task-definition.json.tpl
```

The two-minute screencap: a `stoppedReason` of `Essential container in task exited` with a
non-zero `exitCode`, and the log line matching one of the three runner errors.

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

Then re-dispatch the deploy (staging: merge the fix to `main` again; prod: re-run
`prod-deploy.yml` with the fixed image tag). The migration task re-runs from a clean checkout.

**3b. Lock error → find the holder, or wait it out.**

```sql
-- From the bastion against the primary (docs/runbooks/postgres-conventions.md's connection convention):
SELECT pid, state, query_start, now() - query_start AS age, query
FROM pg_stat_activity
WHERE query ILIKE '%6004517954832980272%'      -- ADVISORY_LOCK_KEY (packages/db/src/runner.ts)
   OR wait_event_type = 'Lock';
```

A live second migration task is the usual suspect — the first (`StartedBy: studafy-migrations`)
may have been retried by a workflow rerun while the original still ran. Either let the earlier
task finish (wait, then re-dispatch) or stop it deliberately. An _orphaned_ lock from a killed
task clears automatically once Postgres reaps the dead session; if `pg_stat_activity` shows
nothing holding it, the lock is gone and the original failure was something else — re-run the
advisory-lock step (`SELECT pg_try_advisory_lock(...)`) to prove it's free before re-dispatching.

**3c. Validation error → never a re-run; fix the repo.**

`MigrationValidationError` means an applied migration's file diverged from what ran (renamed,
edited, or out-of-order pending). Re-running the task reproduces the same validation failure —
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

**5. Close the loop.** The `annotate` job of a _successful_ re-deploy writes the completion line to
`/studafy-<env>/deploys`; if the deploy stays halted, leave the issue open with the decision from
step 4 and the follow-up ticket links. The `deploy-failure` label is what the on-call handoff keyed
on — don't close the issue silently.

## Rollback / abort criteria

Abort the _procedure_ (not the deploy) the moment a second responder starts racing the same fix —
hand the issue over, don't both edit migrations. If step 3c is the verdict, stop entirely: no
environment-side action makes a validation error go away.

## Known gaps

- No automated detection distinguishes the three failure shapes — the `stoppedReason`/log triage
  in step 2 is manual. A CI job that greps the migration task's log for the three error classes and
  labels the issue accordingly is future work.
- A non-transactional migration that partially applied and then failed has no automated "where did
  it stop" report — `db:migrate` re-runs the file from the top each time, and the file is assumed
  idempotent; that assumption should be tested per non-transactional migration, not trusted.
- There is no "deploy without this migration" affordance at all (no skip flag, no env toggle).
  Deferring a release is currently the only halt-consistent option, which is honest but coarse.
- Nothing in this repo exercises `migrate.sh` against a real AWS account — same caveat
  everything in `infra/deploy` carries (`infra/deploy/README.md`'s "Known gaps").
