# `tenant-restore`

Tooling to restore a backup to a scratch instance and extract a single `school_id` slice, for
"school deleted data" recovery without a global point-in-time rollback of the whole Postgres
instance (ST-267). Depends on
[ST-265's backup automation](../../terraform/modules/backup/README.md) — this tool restores from
the same backups that module produces, using the same RDS PITR mechanism its restore-verify drill
already exercises, but for a different problem: that drill proves the _mechanism_ works, not that
any one school's rows are recoverable in isolation from every other school's.

The [runbook](../../../docs/runbooks/tenant-restore.md) covers the operator procedure end to end.
This README covers what the tooling does and why it's built the way it is.

## What this does

| Phase       | Script                    | What it does                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Restore  | `restore-scratch.sh`      | `RestoreDBInstanceToPointInTime` into a scratch instance, waits for it, prints its endpoint. Same mechanism as `modules/backup/restore_verify.tf`, deliberately different instance-identifier prefix (`tenant-restore-*`, not `pg-verify-*`) so the two tools' IAM scopes never overlap.            |
| B. Extract  | `extract-tenant-slice.sh` | Reads every tenant table's rows for one `school_id` off the scratch instance, writes one `data/<table>.sql` per table (plain `INSERT` statements) plus a `manifest.json` audit record (row counts, per-file SHA-256, operator identity, ticket).                                                    |
| C. Apply    | `apply-tenant-slice.sh`   | Loads a slice — some or all of its tables (`--table`, repeatable) — into a target database inside one `psql --single-transaction`. Any failure (checksum mismatch, duplicate key, row-count check) rolls back the whole run; nothing else in the target database is touched, whichever way it goes. |
| D. Teardown | `teardown-scratch.sh`     | Deletes the scratch instance once extraction is done and reviewed. Not automatic — see "Why teardown is manual" below.                                                                                                                                                                              |

`lib/discover-tenant-tables.sql` is the single source of truth for "what is a tenant table and
what order do they load in" — the same `school_id`-column classification
[`db/policies/rls-coverage.ts`](../../../db/policies/rls-coverage.ts) already treats as ground
truth, topologically leveled by FK dependency so ascending-level load order never violates a
foreign key between two tenant tables. `lib/default-excluded-tables.txt` lists tables excluded by
default because restoring an old row in them is itself a side-effecting action (see the file for
each one's specific reason) — override per-run with `--include-table`.

## What this does not do

- **It does not pick which tables to restore for you beyond the default exclusion list.**
  `apply-tenant-slice.sh --table <name>` is how an operator restores only the tables actually
  affected by a real incident, which is the common case — "this school's assignments got deleted"
  is a `--table assignments` run, not a full 98-table one. Applying every table into a database
  that still has most of that school's data intact fails on the first duplicate key, on purpose:
  see "Known gaps" below on why that isn't handled automatically.
- **It does not run unattended.** Unlike `modules/backup`'s weekly restore-verify drill, there is
  no EventBridge Scheduler schedule anywhere in `tenant_restore.tf`. Tenant-slice recovery is a
  human-reviewed, multi-step operation an operator drives interactively.
- **It does not provision a second AWS account or a locked vault for the audit trail.** The S3
  prefix `tenant_restore.tf` scopes this role to (`tenant-restore/*` in the same
  `backups_archive_bucket` `modules/backup` already uses) is access-restricted, not immutable —
  unlike the monthly Vault-Locked snapshot. See "Known gaps".
- **It does not move a slice between environments.** Extraction and application both resolve
  their connection through the same mechanism (`lib/common.sh`'s `resolve_pg_connection`), and the
  intended flow is: restore _this_ environment's own backup to a scratch copy, extract, apply back
  into _this_ environment's own live instance. Recovering data into a different environment than it
  was extracted from is possible mechanically (the manifest and slice files are just JSON and SQL)
  but isn't this tool's designed path and hasn't been exercised.

## Access control and audit trail

`infra/terraform/modules/backup/tenant_restore.tf` creates `aws_iam_role.tenant_restore_operator`
only when `var.tenant_restore_operator_principal_arns` is non-empty — no environment has anyone who
can assume it until that list is set. Assuming it requires
`aws:MultiFactorAuthPresent`. Its permissions are scoped to: describing/restoring/deleting only
instances matching this tool's own `tenant-restore-*` prefix (never the source instance's own
lifecycle), reading (never writing) the Postgres master connection secret, and reading/writing only
the `tenant-restore/*` prefix of the backups archive bucket.

The audit trail is that S3 prefix: every `extract-tenant-slice.sh` run, when given `REPORT_BUCKET`,
uploads its full slice (data files + manifest, including the operator's own
`aws sts get-caller-identity` ARN) there before anything gets applied anywhere. `apply-tenant-slice.sh`
independently re-verifies every file's SHA-256 against the manifest before opening a single
transaction, so a corrupted or tampered slice is caught before it touches a live database.

## Known gaps

- **No `BYPASSRLS` role exists anywhere in this schema, by deliberate design** (see
  `docs/database/role-model.md` and about a dozen other docs that say the same thing). This is the
  single most consequential fact this tool had to be built around, discovered by actually running
  extraction against a real, fully-migrated local Postgres instance rather than only reading the
  schema:
  - `COPY ... FROM` is unconditionally rejected by PostgreSQL against a row-security-enabled table
    for any role that doesn't bypass RLS, regardless of policy. This is why the slice format is
    plain `INSERT` statements (`pg_dump --column-inserts`, applied with plain `psql -f`), not
    `COPY BINARY` — the first version of this tool used `COPY` and failed the moment it tried to
    apply into a real RLS-forced table.
  - `pg_dump` additionally refuses to dump a table it suspects RLS would filter for its owning
    role, unless given `--enable-row-security` — without that flag it errors rather than silently
    producing a partial dump.
  - A partitioned table's data does not come along for free under its parent's name: `pg_dump
--table=app.audit_logs` dumps only the parent's own (always empty) rows. This tool matches
    `app.<name>*` instead for any table `discover-tenant-tables.sql` marks `is_partitioned`, which
    also matches every one of its monthly partitions.
  - Extraction requires the connected role to `SET ROLE studafy_admin` and sets `app.school_id`
    _and_ `app.user_id` (to a real `ORG_ADMIN`/`SUPER_ADMIN` user of the school being extracted) as
    session GUCs — most tenant tables layer a second `role_scope_visibility` policy on top of
    `tenant_isolation` whose backing functions (`app.can_read_class`, `app.teaches_class`, ...) call
    `app.current_user_id()`, which raises `unrecognized configuration parameter` if `app.user_id`
    was never set at all, table empty or not.
  - **`db/migrations/000014`'s `teacher_evaluation_visibility` policy has no admin escape hatch at
    all** — a teacher evaluation is visible only to the teacher being evaluated or the evaluator,
    never to a generic admin, by design (this is a privacy choice, not an oversight). No role this
    tool can assume can read 100% of that table's rows for a school in one query. `extract-tenant-
slice.sh` cross-checks pg_dump's row count against an independent `WHERE school_id = ...` count
    for every table and fails loudly on a mismatch rather than shipping a silently incomplete
    slice — but it cannot make the missing rows readable. If a real recovery ever needs
    `teacher_evaluations` restored, that needs a different procedure (e.g., iterating per
    teacher/evaluator pair), which does not exist today.
  - All of the above was verified against a local, fully-migrated Postgres instance
    (`db/compose.yml`), not against real AWS RDS. Whether the RDS master credential
    (`postgres_connection_secret_arn`) behaves the same way a local Docker superuser does, or is
    itself subject to RLS the way this schema's docs insist every non-`BYPASSRLS` role must be, has
    never been confirmed against live infrastructure — see `modules/backup/README.md`'s own Known
    gaps, which now also flags this for `postgres-restore-verify.sh` (ST-265), whose row-count
    queries assume the opposite and have never been checked either.
- **This entire tool has never been run against real AWS infrastructure.** Consistent with every
  other module in this repo (`infra/terraform/README.md`'s own Status line, ST-266's game-day drill
  report): no AWS account has ever been applied to from this repo. `restore-scratch.sh` and
  `teardown-scratch.sh` are untested beyond `terraform validate` passing for the IAM they depend
  on — `extract-tenant-slice.sh` and `apply-tenant-slice.sh` are the parts that _have_ been run for
  real, against a local Postgres instance seeded with realistic data across every discovered
  tenant table, including a genuine delete-then-restore round trip (see the runbook's "First
  validation" section for what was actually exercised and how).
- **Teardown is a separate, manual script, not an automatic cleanup trap.** ST-265's own drill
  restores, verifies, and deletes unattended in one run because it's a repeatable check with a
  known-good outcome. Tenant-slice extraction can legitimately need more than one pass (an operator
  reviewing a partial mismatch, re-running with `--include-table`), so the scratch instance stays
  up until `teardown-scratch.sh` is run explicitly — which also means a forgotten scratch instance
  will keep billing until someone deletes it. Nothing here reminds an operator to run it.
- **Applying a table that already has rows for that school on the target is a hard failure, not a
  merge.** `apply-tenant-slice.sh` makes no attempt at `ON CONFLICT` / upsert semantics — a
  duplicate key aborts the whole transaction cleanly, which is the right default for "I don't know
  what's already there", but it does mean a genuinely partial table loss (some rows deleted, others
  intact) needs the operator to know which rows are actually missing, not just which table.
