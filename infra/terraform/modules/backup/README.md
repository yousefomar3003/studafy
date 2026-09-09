# `backup`

Backup automation and restore verification for both database planes (ST-265): Postgres (the app
database) and MariaDB/ERPNext (the school-management plane). Policy, RPO/RTO targets, and the
acceptance-criteria-to-mechanism mapping are in
[`docs/architecture/SAD_30_backup_policy.md`](../../../../docs/architecture/SAD_30_backup_policy.md) —
this README covers only what the module does and how to operate it.

## What this module does

| Requirement                                                                 | Mechanism                                                                                                                                                              | File                        |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| WAL archiving + daily base backups                                          | Already true of `module.postgres`/`module.mariadb`'s own `backup_retention_period` — RDS backs it with continuous transaction-log archiving natively.                  | (not this module)           |
| Cross-region copy                                                           | `aws_db_instance_automated_backups_replication`, one per engine, into `var.dr_region`.                                                                                 | `replication.tf`            |
| Monthly immutable object-lock snapshot                                      | AWS Backup vault with Vault Lock (Compliance mode) + a monthly plan/selection covering both engines.                                                                   | `main.tf`                   |
| Weekly automated restore-and-verify (checksums, row counts, RLS spot check) | ECS Fargate task: restores Postgres to a scratch instance via `RestoreDBInstanceToPointInTime`, verifies, deletes it, uploads a JSON report.                           | `restore_verify.tf`         |
| PITR to an arbitrary timestamp, demonstrated in dev                         | The same restore-verify task, given `RESTORE_TIME` — see "Running the dev PITR demo" below.                                                                            | `restore_verify.tf`         |
| ERPNext scheduled site + database backups, off-site retention               | Nightly `bench backup --with-files` per site, uploaded to S3 and deleted from EFS.                                                                                     | `erpnext_backup.tf`         |
| ERPNext site backup restores to a scratch environment                       | Monthly drill: downloads the latest backup, `bench new-site`/`bench restore`/`bench doctor` against a new site on the same MariaDB instance, then drops it.            | `erpnext_backup.tf`         |
| Immutable copy inaccessible with prod credentials                           | Vault Lock Compliance mode (undeletable by anyone until the retention floor passes) + no prod IAM identity anywhere in this repo is granted any `backup:*` permission. | `main.tf`, see "Known gaps" |
| Single-tenant slice restore, tooling access restricted and audited (ST-267) | A dedicated, MFA-gated `tenant_restore_operator` IAM role (empty-by-default principal list) scoped to its own scratch-instance prefix and S3 audit prefix.             | `tenant_restore.tf`         |

## What this module does not do

- **It does not implement WAL-E/pgBackRest or any other third-party backup agent.** RDS already
  archives WAL continuously as the mechanism behind `backup_retention_period`
  (`modules/postgres`/`modules/mariadb`) — standing up a second, hand-rolled continuous-archiving
  pipeline on top of a managed instance would fight the platform, not extend it.
- **It does not provision a second AWS account.** "Inaccessible with prod credentials" is enforced
  by AWS Backup Vault Lock's own undeletability plus this repo never granting any application/deploy
  IAM identity a `backup:*` permission — not by account-boundary isolation, which doesn't exist
  anywhere in this repo's bootstrap stack yet. See "Known gaps".
- **It does not alert anyone on a failed drill.** A failed restore-verify/backup/drill task exits
  non-zero and its JSON report says `"status": "FAIL"` — the same "action-free until notification
  ownership lands" gap `modules/monitoring`'s own alarms already carry.
- **It does not discover ERPNext site hostnames.** They're created imperatively by
  `infra/deploy/scripts/erpnext-new-site.sh`, not by Terraform — `var.erpnext_site_hostnames` must be
  updated by hand alongside every such run.

## Why the Postgres and ERPNext drills use different restore mechanisms

`restore_verify.tf` restores an entire scratch **RDS instance** via `RestoreDBInstanceToPointInTime`.
`erpnext_backup.tf`'s drill instead restores a scratch **site** (`bench new-site` + `bench restore`)
on the _same_ MariaDB instance. This is deliberate, not inconsistent:

- The Postgres acceptance criteria (checksums, row counts, RLS, "PITR to arbitrary timestamp") are
  about RDS's own point-in-time-restore mechanism — the only way to exercise that honestly is to
  actually call it.
- The ERPNext acceptance criterion is "ERPNext **site backup** restores to a scratch environment" —
  about the bench-level backup/restore path (which also carries files, not just database rows).
  Restoring a raw MariaDB-engine snapshot would prove RDS's restore path works (already covered
  generically for both engines by `main.tf`'s AWS Backup selection and `replication.tf`'s
  cross-region replication) without ever exercising `bench backup`/`bench restore` at all.
- A per-school database is already the unit ERPNext's multi-tenancy creates and destroys routinely
  (`infra/deploy/scripts/erpnext-new-site.sh`) — reusing that same primitive for the drill is the
  cheapest scratch environment that actually matches how a real site restore would be performed.

## Usage

```hcl
module "backup" {
  source = "./modules/backup"

  providers = {
    aws    = aws
    aws.dr = aws.dr
  }

  name_prefix           = module.naming.name_prefix
  aws_region            = var.aws_region
  automation_enabled    = var.environment != "dev"
  erpnext_plane_enabled = local.erpnext_plane_enabled
  dr_region             = var.backup_dr_region

  # ... see variables.tf for the full input list (network, postgres, mariadb/erpnext, storage,
  # image references)
}
```

`aws.dr` is a second provider block pointing at `var.backup_dr_region`, the same shape
`infra/terraform/providers.tf`'s `aws.us_east_1` alias already uses for `module.cdn`.

## Running the dev PITR demo

```bash
infra/deploy/scripts/postgres-restore-verify.sh dev --restore-time=2026-09-01T03:15:00Z
```

Restores `module.postgres`'s dev instance to that exact timestamp into a scratch instance, verifies
it, deletes it, and uploads a report — the same job the weekly schedule runs in staging/prod, just
pointed at an explicit timestamp instead of "latest restorable time". Must be a time within
`postgres_backup_retention_days` (default 7) of now.

## Running an ERPNext restore drill on demand

```bash
infra/deploy/scripts/erpnext-restore-drill.sh staging
```

## Tenant-slice restore (ST-267)

`tenant_restore.tf` adds the IAM role `infra/tools/tenant-restore`'s scripts assume to restore a
school's deleted data from a scratch instance without a global point-in-time rollback of the whole
instance — a different problem from this module's own restore-verify drill (which proves the
_mechanism_ works, not that any one school's rows are recoverable in isolation). See
[`infra/tools/tenant-restore/README.md`](../../../tools/tenant-restore/README.md) for the tool
itself and [`docs/runbooks/tenant-restore.md`](../../../../docs/runbooks/tenant-restore.md) for the
runbook. That role does not exist until `var.tenant_restore_operator_principal_arns` names who may
assume it — empty by default, same zero-access-until-configured posture as `backup_service`.

## Known gaps

- **No dedicated backup AWS account.** Vault Lock's Compliance mode makes the monthly snapshot
  physically undeletable regardless, but true blast-radius isolation from a compromised prod
  credential (rather than just "was never granted the permission") needs a second account —
  `infra/terraform/README.md` already documents that this repo's bootstrap stack is single-account.
- **No cross-region copy of the monthly locked vault itself.** `replication.tf`'s continuous-backup
  replication is cross-region; the AWS Backup vault holding the monthly immutable snapshot is not.
  Add an `aws_backup_vault` in `var.dr_region` and a `copy_action` on the plan rule if that gap needs
  closing.
- **`restore_verify.tf`'s `postgres-restore-verify.sh` has never been confirmed to actually see
  RLS-filtered rows against a real RDS master credential.** Building `tenant_restore.tf`'s own
  extraction path (ST-267) against a real local Postgres instance surfaced that this schema
  deliberately has no `BYPASSRLS` role anywhere (`docs/database/role-model.md` and about a dozen
  other docs say so explicitly) — so if the RDS master user does not bypass RLS the way a local
  Docker superuser does, its unfiltered `SELECT count(*) FROM app."table"` calls would need
  `app.school_id` set first or they'd fail outright (`current_setting` with no `missing_ok` on an
  unset GUC raises, it does not return zero rows). Nobody has run this script against real
  infrastructure to find out either way — same "never applied to a live AWS account" status every
  module in this repo already carries. See `infra/tools/tenant-restore/README.md`'s own Known gaps
  for the fuller writeup and the workaround (`SET ROLE studafy_admin` + explicit GUCs) this ticket's
  tooling had to adopt because it cannot assume otherwise.
- **The restore-verify checksum comparison has an unavoidable drift window.** It captures the
  source's baseline immediately before requesting the restore, then compares against the scratch
  instance once available (typically 10-20 minutes later) — any write to the source in that window
  reads as a false mismatch. Acceptable today because no environment in this repo carries real
  production write traffic yet; revisit if that changes.
- **`erpnext-backup.sh`'s `bench` flag names** (`--mariadb-root-username`, `--with-private-files`,
  etc.) are the same ones `infra/deploy/scripts/erpnext-new-site.sh` already established for the
  pinned bench version — not independently re-verified here. Same "not exercised against a live
  account" caveat `modules/erpnext/README.md` already carries.
