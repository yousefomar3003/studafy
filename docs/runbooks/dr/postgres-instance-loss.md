# Scenario 1: Postgres instance loss or corruption

The app database (`module.postgres`, RDS, engine `postgres`) is unreachable, or reachable but
serving corrupted/deleted data. Covers both "the instance is gone" and "the instance is fine but
someone/something wrote garbage into it" — they share a mechanism (PITR restore) and differ only in
which target timestamp you pick.

Mechanism source: [`infra/terraform/modules/backup/restore_verify.tf`](../../../infra/terraform/modules/backup/restore_verify.tf),
[`infra/docker/backup-verify/postgres-restore-verify.sh`](../../../infra/docker/backup-verify/postgres-restore-verify.sh).
Comms templates: [README.md](README.md).

## RPO / RTO target

Per `docs/architecture/SAD_30_backup_policy.md`: **RPO seconds-to-low-minutes** (RDS continuous
WAL archiving, PITR to any second in the retention window). **RTO** — the repo's own weekly
restore-verify drill has observed 10-20 minutes for the _restore_ step alone; this runbook's
cutover adds a rename operation on top (see step 5). Nobody has measured full incident-to-resolved
time against real infra yet — see [the drill report](st-266-game-day-drill-report.md).

## Detection

No CloudWatch alarm fires specifically for "instance unreachable" today —
`modules/monitoring/main.tf` has `rds_cpu`, `postgres_storage`, and `postgres_replica_lag`, none of
which catch a hard outage or silent corruption. In practice this is detected by:

- Application-level connection failures (once a compute tier exists to observe them — none does
  yet, see `infra/terraform/README.md`'s Status).
- `aws rds describe-db-instances --db-instance-identifier ${name_prefix}-postgres` showing a
  non-`available` status.
- A human noticing wrong/missing data and reporting it — the corruption case has no automated
  signal at all; it looks like a normal, successful query until someone reads the result.

**Known gap**: add an RDS `DBInstanceStatus`-based alarm (or use RDS Event Subscriptions) so
"instance down" pages someone instead of waiting for a human to notice. Ticketed in the drill
report.

## Owner

Data-plane operator (see [README.md](README.md)'s ownership table) runs the restore; incident
commander owns the decision points below and the cutover go/no-go.

## Decision points

1. **Corruption or total loss?** Total loss (instance terminated, unrecoverable hardware fault,
   `DBInstanceStatus` stuck in `failed`/`incompatible-restore`) → restore to
   `--use-latest-restorable-time`. Corruption (bad migration, bad manual write, application bug
   that mass-deleted/mutated rows) → restore to an explicit `--restore-time` at or just before the
   bad write. **Getting this wrong in the corruption case restores the bad data too** — find the
   timestamp from the query/deploy/audit log that caused it before restoring, not after.
2. **Is `eu-central-1` itself healthy?** If the source instance is unreachable because the _region_
   is degraded, not because the instance itself failed, this is
   [regional-outage.md](regional-outage.md) instead — a same-region PITR restore has nothing to
   restore from if the region hosting both the primary and its WAL archive is down.
3. **Cutover now or verify-then-cutover?** Default is verify first (step 4) — a restore that
   silently carried the same corruption forward is worse than a slower, confirmed-good one. Skip
   straight to cutover only when the source instance is provably gone (nothing left to compare
   against) and RTO pressure outweighs the verification step.

## Why the automated weekly job isn't the incident procedure

`postgres-restore-verify.sh` (the script the weekly `restore_verify.tf` schedule runs) restores to
a scratch instance named `${name_prefix}-pg-verify-<run-id>`, verifies row-count/checksum/RLS
fidelity against a baseline, uploads a report, and **unconditionally deletes the scratch instance
in its `cleanup()` trap** — every exit path, including success, ends with `aws rds
delete-db-instance`. That is correct for a drill (prove the mechanism works, don't leave a billable
instance running) and wrong for an incident (you need the restored data to survive). The steps
below reuse the same AWS API calls and the same verification queries, without the delete, plus a
cutover the drill script has no reason to do.

## Procedure

**1. Determine the target instance and restore time.**

```bash
SOURCE_ID="$(terraform -chdir=infra/terraform output -raw postgres_db_instance_id)"
# or, from step 1's decision: an explicit ISO-8601 timestamp within the retention window
# (postgres_backup_retention_days, default 7 — modules/postgres/variables.tf)
```

**2. Restore to a new, non-scratch instance — do not reuse the drill's naming or let anything
delete it.**

```bash
RESTORE_ID="${SOURCE_ID}-restored-$(date -u +%Y%m%d-%H%M%S)"

aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$SOURCE_ID" \
  --target-db-instance-identifier "$RESTORE_ID" \
  --db-subnet-group-name "$(terraform -chdir=infra/terraform output -raw ... )" \
  --vpc-security-group-ids "$(terraform -chdir=infra/terraform output -raw ...)" \
  --no-multi-az \
  --no-publicly-accessible \
  --region eu-central-1 \
  --use-latest-restorable-time            # or: --restore-time 2026-09-01T03:15:00Z
```

`--no-multi-az` matches the drill script's own choice for speed; re-enable Multi-AZ (step 6) once
this becomes the real primary — the source instance runs Multi-AZ (`modules/postgres/README.md`),
and this restored instance should too before it takes production traffic.

`--db-subnet-group-name`/`--vpc-security-group-ids` aren't exposed as root Terraform outputs today
— pull them from `module.postgres`'s resources directly (`aws_db_instance.this.db_subnet_group_name`
/`.vpc_security_group_ids` in state, or the AWS console) until that's added. **Known gap**, ticketed
in the drill report.

**3. Wait for it.**

```bash
aws rds wait db-instance-available --db-instance-identifier "$RESTORE_ID" --region eu-central-1
```

Observed 10-20 minutes in the weekly drill; this is the dominant term in RTO.

**4. Verify — reuse the drill's own fingerprint query, by hand, against the restored instance.**

The exact query is in `postgres-restore-verify.sh`'s `TENANT_TABLE_QUERY`/`table_fingerprint()` —
row count + an order-independent content hash per tenant table, plus RLS enabled/forced/policy
presence. Run it against `$RESTORE_ID`'s endpoint from the bastion
(`docs/runbooks/postgres-conventions.md`'s connection convention) and compare against the same
query run against the source (if the source is still reachable) or against your own knowledge of
what should be there (if it's not).

**5. Cut the application over — rename, don't reconfigure PgBouncer.**

`module.pgbouncer`'s `[databases]` host string is rendered into the EC2 instance's `user_data` at
`terraform apply` time from `module.postgres`'s `.address` output
(`modules/pgbouncer/templates/user_data.sh.tftpl`) — it is **not** looked up live from Secrets
Manager or the RDS API at connection time. Editing PgBouncer's config to point at a differently-
named instance means a `terraform apply` that touches the PgBouncer EC2 instance, which is slower
and riskier mid-incident than the alternative: RDS's endpoint DNS name is derived from the instance
_identifier_, so renaming the restored instance into the original identifier gives it the original
endpoint hostname, and PgBouncer's existing (unchanged) config resolves to the restored instance
the moment DNS propagates — no PgBouncer redeploy.

```bash
# Get the broken instance out of the way (don't delete yet — see step 7).
aws rds modify-db-instance --db-instance-identifier "$SOURCE_ID" \
  --new-db-instance-identifier "${SOURCE_ID}-incident-$(date -u +%Y%m%d)" \
  --apply-immediately --region eu-central-1
aws rds wait db-instance-available --db-instance-identifier "${SOURCE_ID}-incident-$(date -u +%Y%m%d)" --region eu-central-1

# Take the vacated identifier.
aws rds modify-db-instance --db-instance-identifier "$RESTORE_ID" \
  --new-db-instance-identifier "$SOURCE_ID" \
  --apply-immediately --region eu-central-1
aws rds wait db-instance-available --db-instance-identifier "$SOURCE_ID" --region eu-central-1
```

**This exact rename-based cutover has not been exercised against this repo's real infrastructure**
— it's the standard AWS-documented PITR recovery pattern (endpoint DNS follows the identifier), not
something this repo has watched PgBouncer actually reconnect through. Flag it as unverified in the
status update, and watch PgBouncer's pool-saturation CloudWatch metrics
(`docs/runbooks/pgbouncer-conventions.md`) after the rename to confirm it reconnected rather than
assuming it.

**6. Re-enable Multi-AZ on the now-primary instance.**

```bash
aws rds modify-db-instance --db-instance-identifier "$SOURCE_ID" --multi-az --apply-immediately --region eu-central-1
```

**7. Do not delete the renamed-aside broken instance immediately.** Keep it (stopped, if cost
matters) until root cause is understood — it may be the only copy of exactly what went wrong, which
the restored copy by definition no longer has.

## Rollback / abort criteria

If verification (step 4) fails — fingerprints don't match what's expected, RLS policies are
missing — do not cut over. Either pick a different `--restore-time` and retry from step 2, or
escalate: something is wrong with the backup chain itself, which is a bigger problem than this one
incident.

## Known gaps

- No automated detection of "instance unreachable" — see Detection above.
- `--db-subnet-group-name`/`--vpc-security-group-ids` aren't root Terraform outputs; pulling them
  requires state access today.
- The rename-based cutover in step 5 is standard AWS practice but has never been run against this
  repo's PgBouncer. First real drill should watch this specifically.
- No script wraps steps 1-6 — every real incident runs them by hand today. A
  `postgres-restore-cutover.sh` (siblings: `infra/deploy/scripts/postgres-restore-verify.sh`) that
  does steps 1-6 without the drill script's delete-on-exit trap would remove most of the manual
  risk here; not built by this ticket, ticketed in the drill report.
