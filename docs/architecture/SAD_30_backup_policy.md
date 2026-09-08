# Backup policy (SAD §30)

RPO/RTO targets for both database planes, and the exact mechanism each acceptance criterion maps to.
Source of the mechanisms: [`infra/terraform/modules/backup`](../../infra/terraform/modules/backup).

## An assumption this document is built on

ST-265 cites **SAD section 30** as the source of this policy. The SAD is not in this repository —
`docs/architecture/SAD_28_logging_conventions.md` records the same gap for section 28,
`docs/architecture/SAD_21_notification_dispatch_flow.md` for section 21,
`db/migrations/000018_create_partitioned_audit_logs.sql` for section 15, and
`docs/api/global-data-erd.md` for section 10. The policy below is therefore taken from the ticket's
own stated acceptance criteria and from what RDS and Frappe/bench actually support, not inferred
from a document nobody here can read. **This document does not claim that the unavailable SAD text
was inspected.** If the real SAD later states different retention/RPO/RTO numbers, a follow-up
ticket reconciles the two — the numbers below are this repo's own documented starting point, not a
compliance-reviewed figure.

## RPO / RTO

| Plane                                     | RPO (max data loss)                                                                                                                                                                                                                                         | RTO (time to restore service)                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres (app database)                   | Seconds to low minutes — RDS continuous backup (WAL-based) allows point-in-time restore to any second within the retention window, same-region or in `var.dr_region` (`replication.tf`).                                                                    | Same-region PITR: the time for `RestoreDBInstanceToPointInTime` to produce an available instance — observed 10-20 minutes in this repo's own weekly drill (`restore_verify.tf`). Regional failover to `var.dr_region`: not yet drilled — see "Known gaps" below.              |
| MariaDB engine (ERPNext plane, raw)       | Same as Postgres — same RDS continuous-backup + cross-region replication mechanism (`replication.tf`), engine-agnostic.                                                                                                                                     | Same as Postgres, restoring the whole instance rather than one site.                                                                                                                                                                                                          |
| ERPNext site (bench-level, per school)    | Up to 24 hours — one `bench backup --with-files` run per night (`erpnext_backup.tf`'s `erpnext_site_backup_schedule`, default 02:00 UTC daily). A mid-day incident loses at most that day's changes for that school.                                        | Time to `bench restore` the latest backup into a fresh site plus reinstate DNS/config for real use — the monthly drill (`erpnext_backup.tf`) measures the restore-to-verified-healthy portion of this, not the full end-to-end cutover, which has no automated procedure yet. |
| Monthly immutable snapshot (both engines) | N/A (compliance/ransomware-recovery copy, not the primary RPO path) — one point per calendar month, retained at least `vault_lock_min_retention_days` (default 400) days, physically undeletable once `vault_lock_changeable_for_days` (default 3) elapses. | Restore from this vault is a manual, undrilled procedure today (`aws backup start-restore-job`) — see "Known gaps".                                                                                                                                                           |

These are the numbers this implementation actually produces, not independently validated business
requirements — no incident-response or compliance review of "how much data loss is acceptable" has
happened in this repo. Revisit once one does.

## Acceptance criteria → mechanism

| Acceptance criterion                                           | How it's met                                                                                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restore-verify job green weekly with report artifact           | `restore_verify.tf`'s EventBridge Scheduler schedule (staging/prod), reporting to `s3://<backups-archive>/reports/postgres/restore-verify/`.                   |
| PITR to arbitrary timestamp demonstrated in dev                | `infra/deploy/scripts/postgres-restore-verify.sh dev --restore-time=<timestamp>` — the same job, given an explicit target instead of "latest restorable time". |
| Immutable copy inaccessible with prod credentials              | AWS Backup Vault Lock, Compliance mode (`main.tf`) — see "What 'immutable' and 'inaccessible' actually mean here" below.                                       |
| ERPNext site backup restores to a scratch environment in drill | `erpnext_backup.tf`'s monthly restore-drill task: `bench new-site` + `bench restore` + `bench doctor` against a fresh site on the existing MariaDB instance.   |
| RPO/RTO documented for both planes                             | This document.                                                                                                                                                 |

## What "immutable" and "inaccessible with prod credentials" actually mean here

There is no second AWS account in this repo's bootstrap stack
(`infra/terraform/README.md`) — every environment lives in one account. Given that constraint, this
policy delivers the two properties the acceptance criterion asks for through two independent
mechanisms rather than account-level isolation:

1. **Immutable**: AWS Backup Vault Lock in **Compliance mode**. Once `changeable_for_days` elapses,
   no principal — including the account root — can delete a recovery point or remove the lock before
   `min_retention_days` has passed. This is a platform-enforced guarantee, not an IAM policy that a
   sufficiently-privileged identity could bypass.
2. **Inaccessible with prod credentials**: no IAM identity anything in this repo's request path uses
   day-to-day — the Postgres/MariaDB master credentials, the shared ECS execution role, any task
   role, the CI `deploy_pull` role — is granted any `backup:*` permission anywhere. The only role
   that can touch the vault is `aws_iam_role.backup_service` (`main.tf`), assumable only by the
   `backup.amazonaws.com` service principal, never by an application or operator credential.

Together: even an attacker or a bug with full control of every "prod" credential in this repo cannot
reach the vault, and even an AWS account administrator cannot delete what's in it before the lock
expires. What this is _not_ is blast-radius isolation from a compromised **account-root** or
Terraform-apply credential, which could still modify `main.tf` itself before the lock takes effect
(within `changeable_for_days`) or provision a new, unlocked path. Closing that last gap needs a
separate backup-owner AWS account with its own root — out of scope for this ticket; see
`modules/backup/README.md`'s "Known gaps".

## Known gaps

- **No drilled regional failover.** `replication.tf` proves the continuous-backup _copy_ lands in
  `var.dr_region`; nothing in this repo has actually promoted a DR-region replica to primary during
  a simulated regional outage. The RTO row above reflects only the same-region restore this repo's
  own weekly job exercises.
- **No drilled restore from the monthly locked vault.** The vault's _creation_ and _immutability_ are
  exercised by `terraform apply` itself; an actual `aws backup start-restore-job` against a locked
  recovery point has not been run in this repo.
- **ERPNext RTO stops at "site restored and bench doctor passes".** Re-pointing real traffic at a
  restored site (DNS, `FRAPPE_SITE_NAME_HEADER` routing, notifying the school) is an undocumented
  manual procedure today.
