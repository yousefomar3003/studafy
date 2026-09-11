# Tenant-slice restore

Recovering one school's deleted or corrupted data — "someone deleted this school's assignments",
not "the whole database is gone" — without a global point-in-time rollback that would also undo
every _other_ school's writes since the bad delete. If the incident is instance-wide (the whole
Postgres instance is gone or corrupted), use
[`docs/runbooks/dr/postgres-instance-loss.md`](dr/postgres-instance-loss.md) instead — that
runbook's PITR cutover affects every tenant at once, which is the right tool for that scenario and
the wrong one for this one.

Mechanism source: [`infra/tools/tenant-restore/`](../../infra/tools/tenant-restore/). Depends on
[ST-265's backup automation](../../infra/terraform/modules/backup/README.md) — this procedure
restores from the same backups that module produces.

## When to use this

- A school's data was deleted or corrupted by a bug, an operator mistake, or a malicious/mistaken
  admin action, and other schools have written data since — a full-instance PITR restore would
  undo those other schools' writes too.
- You know (or can find out) roughly which tables and which school are affected. This procedure
  does not discover "what changed" for you.

## Owner

Data-plane operator, same role as the DR runbooks' owner
([`docs/runbooks/dr/README.md`](dr/README.md)) — this is a narrower-blast-radius sibling of that
same skill set, not a different on-call rotation.

## Access prerequisite

Assume `infra/terraform/modules/backup/tenant_restore.tf`'s `aws_iam_role.tenant_restore_operator`
(MFA required). If nobody can assume it, `var.tenant_restore_operator_principal_arns` has never
been set for this environment — that is itself the first thing to fix, the same "gap #2, fixable
independent of everything else" shape
[ST-266's drill report](dr/st-266-game-day-drill-report.md) already named for the DR vault's own
break-glass role.

```bash
aws sts assume-role \
  --role-arn "$(terraform -chdir=infra/terraform output -raw tenant_restore_operator_role_arn)" \
  --role-session-name "tenant-restore-$(date -u +%Y%m%d-%H%M%S)" \
  --serial-number "<your MFA device ARN>" --token-code "<current MFA code>"
```

Export the returned `AccessKeyId`/`SecretAccessKey`/`SessionToken` before every step below.

## Decision points

1. **Which school, which tables?** Get the `school_id` and, if known, exactly which tables were
   affected — from the report, ticket, or audit trail (`app.audit_logs` for that school, if it
   itself wasn't among the deleted tables). Restoring only the affected table(s) in the apply step
   is what keeps this a _slice_ restore — see `infra/tools/tenant-restore/README.md`'s note on why
   applying every table into a database that still has most of that school's data intact just fails
   on the first duplicate key.
2. **How far back?** Same corruption-vs-loss judgment call as
   [`postgres-instance-loss.md`'s decision point 1](dr/postgres-instance-loss.md) — restore to a
   timestamp at or just before the bad write, found from whatever log/deploy/audit trail identifies
   it, not "latest restorable time" (which would include the deletion).
3. **Staging validation first, or straight to prod?** Default is staging first — restore the
   scratch instance and extract in the affected environment itself (its own backups, its own
   scratch instance, its own live database), review the manifest and row counts, and only then
   apply. Skip straight to prod only when the missing data is actively breaking something and the
   school/table/timestamp are already unambiguous.

## Procedure

**1. Restore a scratch instance from the environment's own backup.**

```bash
AWS_REGION=eu-central-1 infra/tools/tenant-restore/restore-scratch.sh \
  --source-db-instance-id "$(terraform -chdir=infra/terraform output -raw postgres_db_instance_id)" \
  --db-subnet-group-name "<from modules/network, see modules/backup/README.md's Known gaps on this not being a root output yet>" \
  --db-security-group-id "<same>" \
  --restore-time "2026-09-01T03:15:00Z"   # omit for latest restorable time
```

Prints the scratch instance's endpoint once available (typically 10-20 minutes) and the next
command to run.

**2. Extract the school's slice from the scratch instance.**

```bash
CONNECTION_SECRET_ARN="$(terraform -chdir=infra/terraform output -raw postgres_connection_secret_arn)" \
AWS_REGION=eu-central-1 \
PGHOST_OVERRIDE="<scratch endpoint from step 1>" \
REPORT_BUCKET="$(terraform -chdir=infra/terraform output -raw backups_archive_bucket_name)" \
infra/tools/tenant-restore/extract-tenant-slice.sh \
  --school-id "<uuid>" --out-dir ./tenant-restore-slice --ticket "<this ticket>"
```

Review `./tenant-restore-slice/manifest.json` — table list, row counts, which tables were skipped
and why (`skipped_tables`) — before going anywhere near step 3. This is the point to stop and
escalate if the row counts don't look like what the incident report described.

**3. Apply the affected table(s) to the target.**

```bash
CONNECTION_SECRET_ARN="$(terraform -chdir=infra/terraform output -raw postgres_connection_secret_arn)" \
AWS_REGION=eu-central-1 \
infra/tools/tenant-restore/apply-tenant-slice.sh \
  --manifest ./tenant-restore-slice/manifest.json \
  --confirm-school-id "<the same uuid, repeated>" \
  --table assignments --table assignment_submissions   # only the tables actually affected
```

Omit `--table` entirely only for a genuine full-tenant loss where every table is missing for this
school — otherwise the run aborts on the first table that already has rows (see the tool README).

**4. Validate, then tear down the scratch instance.**

Run this school's own application-level checks — the tool restores rows, it does not certify
business correctness (a restored `assignment_submissions` row referencing a since-deleted
`assignments` row would load fine and still be nonsensical to the product). Once satisfied:

```bash
AWS_REGION=eu-central-1 infra/tools/tenant-restore/teardown-scratch.sh \
  --scratch-db-instance-id "<from step 1's output>"
```

## Rollback / abort criteria

`apply-tenant-slice.sh` already aborts atomically on its own (checksum mismatch, duplicate key, or
row-count check failure all roll back the whole run, touching nothing). Beyond that:

- If the extracted row counts don't match the incident's own description of what was lost, **stop
  before step 3** — applying a slice you don't understand is worse than a slower, correct one, the
  same principle `postgres-instance-loss.md`'s own decision point 3 states for a full restore.
- If `extract-tenant-slice.sh` fails with a table-level row-count cross-check mismatch (see the
  tool README's Known gaps on `teacher_evaluations`-shaped tables), that table's rows are not fully
  recoverable through this tool with any role it can assume — do not attempt to work around it by
  re-running with different flags; escalate.

## First validation

This tool has never been run against real AWS infrastructure — no AWS account has ever been
applied to from this repo (`infra/terraform/README.md`'s Status line;
[ST-266's drill report](dr/st-266-game-day-drill-report.md) found the same for every DR runbook).
What was actually validated, against a local, fully-migrated Postgres instance
(`db/compose.yml`, seeded via `db/seeds/seed.ts`) rather than staging:

1. **Full-schema extraction**: `extract-tenant-slice.sh` against a seeded school across every
   discovered tenant table (98 of 106, 8 default-excluded) — 1,162 rows extracted, manifest
   generated, every per-table row count independently cross-checked.
2. **A genuine delete-then-restore round trip**: deleted a table's rows for the seeded school
   directly (`DELETE FROM app.grades WHERE school_id = ...`), then ran `apply-tenant-slice.sh
--table grades` against the _same_ database, and confirmed the exact rows (row count and a
   `sum(score)` check) came back.
3. **Every safety guard, independently**: a wrong `--confirm-school-id` refused to apply; a
   tampered slice file failed its checksum check before any transaction opened.
4. **Two real bugs found only by running this, not by reading the schema** — both are now
   accounted for in the tooling and documented in
   [`infra/tools/tenant-restore/README.md`](../../infra/tools/tenant-restore/README.md)'s Known
   gaps: `COPY ... FROM` is rejected outright on RLS-forced tables regardless of role or policy
   (switched the slice format to `INSERT` statements), and a partitioned table's data doesn't
   dump under its parent's name without a wildcard `--table` pattern.

**What staging validation still needs, to close the acceptance criterion for real**: an actual
`infra/terraform apply` somewhere (`ST-266` gap #1, pre-existing and blocking every runbook in this
repo, not specific to this one), then re-running steps 1-4 above against staging's own restored
scratch instance instead of a local Docker Postgres.

## Known gaps

See [`infra/tools/tenant-restore/README.md`](../../infra/tools/tenant-restore/README.md)'s own
Known gaps section for the full list (the `BYPASSRLS`-free schema's consequences for this tool,
the `teacher_evaluations` visibility limitation, teardown being manual, no upsert semantics on
apply). Runbook-specific gaps:

- **`--db-subnet-group-name`/`--db-security-group-id` for step 1 aren't root Terraform outputs
  today** — the same gap `ST-266`'s drill report already ticketed
  ([#283](https://github.com/yousefomar3003/studafy/issues/283)) for the DR runbooks' identical
  need.
- **No security-incident variant of this runbook exists.** If the deletion was malicious rather
  than accidental, `docs/runbooks/dr/ransomware-immutable-vault-restore.md`'s decision point 1
  ("do not restore using credentials you suspect are compromised") applies here too, but this
  runbook does not spell out that branch — assume it and escalate to security first if there is any
  doubt about how the data was actually deleted.
