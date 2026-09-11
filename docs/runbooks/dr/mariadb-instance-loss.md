# Scenario 2: MariaDB engine instance loss or corruption

The ERPNext plane's underlying RDS instance (`module.mariadb`, engine `mariadb`, staging/prod only
— `local.erpnext_plane_enabled`) is unreachable or corrupted **at the instance level** — every
school's data on it, not one school's site. A single school's bad data is
[erpnext-site-loss.md](erpnext-site-loss.md) instead; restoring the whole instance for a one-school
problem takes every other school down for no reason (see [README.md](README.md)'s decision
framework, point 2).

Mechanism source: [`infra/terraform/modules/backup/replication.tf`](../../../infra/terraform/modules/backup/replication.tf)
(cross-region continuous backup, engine-agnostic) and `modules/mariadb/main.tf` (the instance
itself, same `backup_retention_period`-backed continuous WAL-equivalent archiving RDS provides for
any engine). Comms templates: [README.md](README.md).

## RPO / RTO target

Same as scenario 1 per `docs/architecture/SAD_30_backup_policy.md`: seconds-to-low-minutes RPO,
same-region-restore RTO not yet measured against real infra.

## The gap this scenario exists to name: there is no automated drill for this plane

`modules/backup/restore_verify.tf` — the weekly job, the checksum/RLS verification queries, the
report artifact — is **Postgres-only**. Nothing in this repo periodically restores the MariaDB
_instance_ and checks it. `erpnext_backup.tf`'s monthly drill restores a _site_ (a logical database
on the same running instance, via `bench restore`) — it never exercises
`RestoreDBInstanceToPointInTime` against the MariaDB engine at all, and its own README says so
(`modules/backup/README.md`'s "Why the Postgres and ERPNext drills use different restore
mechanisms"). So this scenario's mechanism is real (RDS continuous backup works the same way
regardless of engine) but genuinely **has never been exercised once**, automated or manual, in this
repo — not even at drill scale. This is the most under-verified of the six scenarios and should be
the first target for a `restore_verify.tf`-equivalent MariaDB job.

## Detection

Same gap as scenario 1: no `DBInstanceStatus` alarm. `modules/monitoring/main.tf` has no MariaDB-
specific alarm at all (`rds_cpu` covers both engines by instance ID list;
`postgres_storage`/`postgres_replica_lag` are Postgres-named and Postgres-only). ERPNext's own
long-running services (`modules/erpnext`) failing their health checks against a dead DB is the most
likely real-world signal.

## Owner

Data-plane operator; incident commander owns cutover go/no-go — same roles as scenario 1.

## Decision points

1. **Confirm this is instance-level, not site-level** — a school reporting "my gradebook is wrong"
   is scenario 3 almost every time; this scenario is for the instance itself being down or every
   school's data being wrong simultaneously.
2. **Corruption or total loss?** Same logic as scenario 1: find the causing timestamp before
   restoring for corruption; use latest-restorable-time for total loss.
3. **Regional?** Same redirect as scenario 1 to [regional-outage.md](regional-outage.md) if
   `eu-central-1` itself is the problem.

## Procedure

No script exists for any of this — every step below is a direct AWS CLI call, adapted from
`postgres-restore-verify.sh`'s Postgres procedure to the MariaDB engine (the RDS API is the same
shape for both; `RestoreDBInstanceToPointInTime` takes an `--engine`-agnostic identifier, not a
Postgres-specific one).

**1. Identify source and target restore time.**

```bash
SOURCE_ID="$(terraform -chdir=infra/terraform output -raw mariadb_address | cut -d. -f1)"
# mariadb_address is the endpoint hostname, not the identifier — module.mariadb's identifier
# is "${name_prefix}-mariadb" (modules/mariadb/main.tf); no root output exposes the raw
# db_instance_id today (module.mariadb.db_instance_id exists, isn't wired to root outputs.tf).
# Known gap — use the literal identifier "${name_prefix}-mariadb" until it is.
```

**2. Restore to a new instance.**

```bash
RESTORE_ID="studafy-staging-mariadb-restored-$(date -u +%Y%m%d-%H%M%S)"

aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier studafy-staging-mariadb \
  --target-db-instance-identifier "$RESTORE_ID" \
  --no-multi-az \
  --no-publicly-accessible \
  --region eu-central-1 \
  --use-latest-restorable-time            # or --restore-time <ISO-8601>

aws rds wait db-instance-available --db-instance-identifier "$RESTORE_ID" --region eu-central-1
```

**3. Verify.** No fingerprint script exists for this engine — MariaDB has no RLS concept and this
repo's tenant isolation for ERPNext is per-database (one logical MariaDB database per school,
`infra/deploy/scripts/erpnext-new-site.sh`), not row-level. Minimum verification: connect (from the
bastion) and confirm each expected per-school database is present with a plausible row count in a
core table (`tabUser` — the same table `erpnext-restore-drill.sh`'s row-count check already uses):

```sql
SHOW DATABASES;
SELECT COUNT(*) FROM `<school_db>`.tabUser;
```

**4. Cut over.** Same rename pattern as scenario 1 — ERPNext's bench containers read `DB_HOST` from
`var.erpnext_mariadb_address` at container start (`erpnext_backup.tf`'s
`erpnext_bench_environment` local, and identically in `modules/erpnext/main.tf`), baked in the same
way PgBouncer's host is. Renaming the restored instance into the original identifier is the same
DNS-follows-identifier trick as scenario 1's step 5, with the same "never verified against this
repo's real ERPNext containers" caveat.

```bash
aws rds modify-db-instance --db-instance-identifier studafy-staging-mariadb \
  --new-db-instance-identifier studafy-staging-mariadb-incident-$(date -u +%Y%m%d) \
  --apply-immediately --region eu-central-1
aws rds wait db-instance-available --db-instance-identifier studafy-staging-mariadb-incident-$(date -u +%Y%m%d) --region eu-central-1

aws rds modify-db-instance --db-instance-identifier "$RESTORE_ID" \
  --new-db-instance-identifier studafy-staging-mariadb \
  --apply-immediately --region eu-central-1
aws rds wait db-instance-available --db-instance-identifier studafy-staging-mariadb --region eu-central-1
```

Unlike PgBouncer, ERPNext's long-running services (backend/websocket/queue/scheduler,
`modules/erpnext/main.tf`) are ECS tasks — restarting them (`aws ecs update-service --force-new-
deployment`) after the rename forces a fresh DNS resolution immediately rather than waiting on any
existing connection's TTL, and is cheap enough to do unconditionally as part of cutover.

**5. Re-enable Multi-AZ**, same as scenario 1 step 6.

## Rollback / abort criteria

Same as scenario 1: a verification failure means do not cut over — retry with a different restore
time, or escalate a backup-chain problem.

## Known gaps

- **No automated restore-verify drill for this plane at all** — the headline gap this runbook
  exists to name. Building a MariaDB equivalent of `restore_verify.tf` is the single highest-value
  follow-up from this scenario.
- No root Terraform output for the MariaDB instance identifier (only the endpoint address).
- No MariaDB-specific CloudWatch alarm.
- No script for any step above — entirely manual today.
