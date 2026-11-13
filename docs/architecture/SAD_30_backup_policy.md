# Backup policy (SAD §30)

RPO/RTO targets for the database planes, and the mechanism each acceptance criterion maps to.

**Status: the AWS backup mechanisms this policy was written against are gone.** AWS was retired in
November 2026 and, with it, the `infra/terraform/modules/backup` module: RDS continuous backup and
point-in-time restore, cross-region backup replication, the weekly restore-verify job, the AWS
Backup Vault Lock monthly snapshot, and the nightly ERPNext `bench backup` task. Production now runs
on fly.io with Postgres on Supabase and files on Cloudflare R2 ([`infra/fly/README.md`](../../infra/fly/README.md)).
The earlier AWS version of this document is in git history.

## An assumption this document is built on

ST-265 cites **SAD section 30** as the source of this policy. The SAD is not in this repository —
`docs/architecture/SAD_28_logging_conventions.md` records the same gap for section 28,
`docs/architecture/SAD_21_notification_dispatch_flow.md` for section 21,
`db/migrations/000018_create_partitioned_audit_logs.sql` for section 15, and
`docs/api/global-data-erd.md` for section 10. The policy below is therefore taken from the ticket's
own stated acceptance criteria and from what the hosting platform and Frappe/bench actually support, not inferred
from a document nobody here can read. **This document does not claim that the unavailable SAD text
was inspected.** If the real SAD later states different retention/RPO/RTO numbers, a follow-up
ticket reconciles the two — the numbers below are this repo's own documented starting point, not a
compliance-reviewed figure.

## Current state

| Plane                   | Where it lives                                  | Backup                                                                                      | RPO / RTO           |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------- |
| Postgres (app database) | Supabase project `studafy-prod`, `eu-central-1` | Supabase's own backups for the project's plan. Not configured or verified from this repo.   | **Not yet defined** |
| Files                   | Cloudflare R2, bucket `studafy-prod-files`      | None beyond R2's own durability. No versioning or second copy is configured from this repo. | **Not yet defined** |
| Redis                   | Redis Cloud, `eu-central-1`, AOF every second   | Redis Cloud's persistence; Redis holds queues and caches, not records of truth.             | **Not yet defined** |
| ERPNext                 | Not deployed on fly.io                          | —                                                                                           | —                   |

These are the facts the repo can state, not a policy: no RPO/RTO target, retention period, immutable
copy, or restore drill has been defined for Supabase or R2 yet.

The single-database-per-deployment assumption this policy is written against is recorded in
[ADR-0008](../adr/0008-tenancy-model.md).

## Acceptance criteria → mechanism

| Acceptance criterion                                           | How it's met                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Restore-verify job green weekly with report artifact           | Not met: the AWS restore-verify job was removed; none on Supabase. |
| PITR to arbitrary timestamp demonstrated                       | Not met on Supabase; not demonstrated from this repo.              |
| Immutable copy inaccessible with prod credentials              | Not met: the AWS Backup Vault Lock copy was removed.               |
| ERPNext site backup restores to a scratch environment in drill | Not applicable while ERPNext is not deployed.                      |
| RPO/RTO documented for both planes                             | Not met: see "Current state".                                      |

## Known gaps

- **No defined backup policy for Supabase.** Which backups and point-in-time recovery the project's
  plan includes, how long they are kept, and how a restore is performed and verified all need to be
  decided and written down here.
- **No backup of R2 files.** A deleted or overwritten object has no second copy configured from this
  repo.
- **No immutable copy.** Nothing replaces the AWS Vault Lock snapshot, so a compromised production
  credential could reach every copy of the data.
- **No restore drill.** Disaster-recovery procedures for this stack are not defined
  ([`docs/runbooks/dr/README.md`](../runbooks/dr/README.md)).
