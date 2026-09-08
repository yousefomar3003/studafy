# Disaster recovery runbooks (ST-266)

Step-level runbooks for six DR scenarios, plus the first game-day drill report. Source of the
mechanisms every runbook here operates:
[`infra/terraform/modules/backup`](../../../infra/terraform/modules/backup) (ST-265) and its policy
doc, [`docs/architecture/SAD_30_backup_policy.md`](../../architecture/SAD_30_backup_policy.md).
That doc says _what_ the RPO/RTO targets are and which mechanism meets which acceptance criterion;
this directory says _what a human does, in order, with which command,_ when one of the six failure
shapes below actually happens.

## Status — read this before treating any runbook below as "ready to run in prod"

**Nothing in `infra/terraform` has ever been applied to a real AWS account.** Every module's own
README says so (`modules/compute/README.md`, `modules/pgbouncer/README.md`, ... : "not exercised
against a live AWS account"), and `infra/terraform/README.md`'s own Status line confirms no app
compute tier is live yet either. This is not a gap this ticket introduces — it's the environment
this ticket inherited. Consequently:

- The **mechanisms** below (RDS PITR restore, `bench backup`/`restore`, AWS Backup Vault Lock,
  cross-region automated-backups replication) are read directly from the Terraform/script source
  and are accurate to what that code does.
- The **operational sequencing** (decision points, cutover steps, comms) is this ticket's own
  addition — written to be directly executable once an environment exists, but not yet exercised
  against one.
- The **first drill** ([`st-266-game-day-drill-report.md`](st-266-game-day-drill-report.md))
  documents exactly what could be verified today (`terraform validate`, source-level review of
  every script this ticket's mechanisms depend on) versus what requires a real AWS account and
  could not be run — and tickets that gap explicitly rather than reporting a number nobody measured.

## Canonical naming

- **Runbook filenames** are a kebab-case noun phrase naming _what broke_, not which AWS API fixes
  it (`postgres-instance-loss.md`, not `pitr-restore.md`) — a responder searches by symptom.
- **Environment tokens**: `dev | staging | prod`, exactly as `infra/terraform/README.md` defines
  them. Never "production", "prd", or "live".
- **Resource/task names** quoted in a procedure are reproduced verbatim from the `.tf`/`.sh` source
  (`${name_prefix}-postgres`, `${name_prefix}-backup-pg-restore-verify`, …) — never invented
  shorthand. `name_prefix` is `${project}-${environment}`, e.g. `studafy-staging`
  (`modules/naming/main.tf`).
- **Scenario numbers** (1-6) are stable identifiers for cross-referencing (tickets, the drill
  report, alarms) — do not renumber; append if a seventh scenario is ever added.

## The six scenarios

| #   | Runbook                                                                        | Failure                                                                                                               | Mechanism                                                                            | Automation status                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [postgres-instance-loss.md](postgres-instance-loss.md)                         | App-database instance lost or corrupted                                                                               | RDS PITR restore, same region                                                        | Weekly restore-_verify_ runs automatically (`restore_verify.tf`); the real-incident _cutover_ procedure is this runbook's own addition — no script does it                   |
| 2   | [mariadb-instance-loss.md](mariadb-instance-loss.md)                           | ERPNext's raw MariaDB engine instance lost or corrupted                                                               | RDS PITR restore, same region                                                        | Same RDS mechanism as #1; **no automated drill exists for this plane** — `restore_verify.tf` is Postgres-only                                                                |
| 3   | [erpnext-site-loss.md](erpnext-site-loss.md)                                   | One school's ERPNext site data lost or corrupted                                                                      | `bench backup` / `bench restore`                                                     | Nightly backup + monthly restore-drill run automatically (`erpnext_backup.tf`); drill restores to a scratch site, not the real hostname — this runbook adds the real cutover |
| 4   | [ransomware-immutable-vault-restore.md](ransomware-immutable-vault-restore.md) | Prod credentials compromised / live backups also tampered with                                                        | AWS Backup Vault Lock (Compliance mode) restore                                      | No automation, no drill, **no operator IAM identity can even call `backup:StartRestoreJob` today** — by design, and unresolved                                               |
| 5   | [regional-outage.md](regional-outage.md)                                       | `eu-central-1` itself is unavailable                                                                                  | Cross-region automated-backups replication into `eu-west-1`, then PITR restore there | Continuous replication runs today; **no network exists in the DR region to restore into** — undrilled and currently unexecutable                                             |
| 6   | [full-infrastructure-loss.md](full-infrastructure-loss.md)                     | Terraform-managed resources destroyed (bad `apply`/`destroy`, deleted state) but the AWS account and its data survive | Rebuild via `terraform apply` + restore data                                         | No automation, undrilled, most steps are this runbook's first documentation                                                                                                  |

## Ownership — roles, not people

This repo has no on-call roster or paging tool. `modules/monitoring/README.md` is explicit that
every CloudWatch alarm is `alarm_actions = []` ("notification ownership is still to be agreed"),
and `docs/runbooks/deploy-rollback.md` works around the identical gap by opening a GitHub issue as
the interim alert. DR follows the same convention until a real one exists:

| Role                    | Responsibility                                                                                    | Interim proxy                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Incident commander (IC) | Declares the DR event, owns every decision point in the runbook, single point of truth for status | Whoever acknowledges the `dr-incident` issue first                      |
| Data-plane operator     | Holds (or requests) the AWS credentials to actually run the restore/cutover commands              | The infra ticket's assignee                                             |
| Comms lead              | Posts the templates below on the schedule below                                                   | Same person as IC unless the incident is large enough to split the role |

Every runbook's own "Owner" line names the role, not a person — resolve the role to a name at
declaration time, in the initial notification below.

## Comms templates

Shared across all six runbooks so each one only has to say "use README.md's templates" — the
templates don't vary by scenario, only their content does.

**Initial notification** — open a GitHub issue, label `dr-incident`, within 15 minutes of
detection (the same "durable, assignable, no channel to page into" pattern
`docs/runbooks/deploy-rollback.md` already uses for `deploy-failure`):

```
Title: [DR] <scenario name> — <environment> — declared <UTC timestamp>

Detected: <alarm / report / human observation that triggered this>
Scope: <service / plane / school(s) affected>
Runbook: docs/runbooks/dr/<file>.md
Incident commander: <role holder>
Status: investigating
```

**Status update** — every 30 minutes until resolved, and at every decision point the runbook
defines:

```
Update <N> — <UTC timestamp>
Step reached: <runbook step #>
RPO so far: <measured, or "unknown until verification query runs">
ETA: <best estimate, or "unknown — blocked on decision point #x">
```

**Resolution**:

```
Resolved <UTC timestamp>.
Measured RPO: <>
Measured RTO: <>
Root cause: <link>
Follow-up tickets: <links — every runbook's "Known gaps" section is a source of these>
```

## Drill cadence

- **Weekly, automated**: Postgres restore-verify (`restore_verify.tf`'s EventBridge Scheduler
  schedule, staging/prod) — scenario #1's restore mechanism exercising itself continuously. Not a
  substitute for the cutover half of scenario #1's runbook, which it deliberately never runs (see
  that runbook's "Why the automated job isn't the incident procedure").
- **Monthly, automated**: ERPNext restore drill (`erpnext_backup.tf`) — scenario #3's restore
  mechanism, same caveat.
- **At minimum annually**, or after any change to `modules/backup`/`modules/postgres`/
  `modules/mariadb`/`modules/network`/`modules/erpnext`: a full game-day covering all six scenarios
  in staging. [`st-266-game-day-drill-report.md`](st-266-game-day-drill-report.md) is both this
  ticket's own deliverable and the template the next one should copy.

## Decision framework common to every scenario

Every runbook below opens with the same first decision, because getting it wrong wastes the most
time: **is this actually the scenario it looks like?**

1. Confirm scope before acting — a Postgres connection failure that's actually a security-group or
   PgBouncer problem is not scenario #1, and running a PITR restore for it destroys nothing but
   wastes 10-20 minutes and produces a scratch instance to clean up. Check
   `aws rds describe-db-instances` / `aws ecs describe-tasks` status first.
2. Confirm blast radius before choosing a mechanism — a single school's bad data is scenario #3
   (site-level), not #2 (instance-level); restoring the whole MariaDB instance to fix one school's
   corrupted rows takes every other school's site down for the restore window for no reason.
3. Confirm this isn't actually a regional or full-account event wearing a smaller scenario's
   clothes — if the source instance itself is unreachable because the region is down, follow
   [regional-outage.md](regional-outage.md), not #1/#2.

Each runbook's own "Decision points" section is scenario-specific detail on top of this.
