# Disaster recovery runbooks (ST-266)

Shared roles, comms templates and decision framework for a disaster-recovery event, plus the first
game-day drill report and the cross-tenant tabletop exercise. The backup policy (RPO/RTO targets) is
[`docs/architecture/SAD_30_backup_policy.md`](../../architecture/SAD_30_backup_policy.md).

## Status — read this first

**No DR scenario runbook exists for the current production stack.** The six step-level runbooks
ST-266 wrote (Postgres instance loss, MariaDB instance loss, ERPNext site loss, ransomware /
immutable-vault restore, regional outage, full infrastructure loss) and the tenant-slice restore
runbook (ST-267) operated the AWS stack — RDS point-in-time restore, AWS Backup Vault Lock,
cross-region backup replication, the RDS-based `infra/tools/tenant-restore` tool — and were removed
with it. They are in git history before the commit that dropped AWS.

Production now runs on fly.io with managed services around it ([`infra/fly/README.md`](../../../infra/fly/README.md)):
Postgres on Supabase (project `studafy-prod`), Redis on Redis Cloud, files on Cloudflare R2
(bucket `studafy-prod-files`). Restore, failover and rebuild procedures for these — including
restoring a single school's data without rolling back every other school — **are not yet
defined or drilled**. Until they are, treat a data-loss event as an incident under the roles and
templates below, and work from the provider's own console and documentation.

## Canonical naming

- **Runbook filenames** are a kebab-case noun phrase naming _what broke_, not which provider API
  fixes it (`postgres-instance-loss.md`, not `pitr-restore.md`) — a responder searches by symptom.
- **Environment**: there is one deployed environment, `prod` (`APP_ENV=production`,
  [`infra/README.md`](../../../infra/README.md#environments)). There is no staging environment to
  drill in.
- **Resource names** quoted in a procedure are reproduced verbatim from their source (the fly app
  names in `infra/fly/*.toml`, the Supabase project ref, the R2 bucket) — never invented shorthand.
- **Scenario numbers** (1-6) from ST-266 remain stable identifiers for cross-referencing the drill
  report and old tickets — do not reuse them for different scenarios.

## Ownership — roles, not people

This repo has no paging tool. DR follows the same convention as the rest of the incident runbooks —
a GitHub issue is the durable, assignable alert — until a real one exists:

| Role                    | Responsibility                                                                                   | Interim proxy                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Incident commander (IC) | Declares the DR event, owns every decision, single point of truth for status                     | Whoever acknowledges the `dr-incident` issue first                      |
| Data-plane operator     | Holds (or requests) access to the fly organisation and the Supabase, Redis Cloud and R2 consoles | The infra ticket's assignee                                             |
| Comms lead              | Posts the templates below on the schedule below                                                  | Same person as IC unless the incident is large enough to split the role |

Resolve each role to a name at declaration time, in the initial notification below.

## Comms templates

The templates don't vary by scenario, only their content does.

**Initial notification** — open a GitHub issue, label `dr-incident`, within 15 minutes of
detection:

```
Title: [DR] <scenario name> — <environment> — declared <UTC timestamp>

Detected: <alert / report / human observation that triggered this>
Scope: <service / plane / school(s) affected>
Runbook: <docs/runbooks/... or "none defined">
Incident commander: <role holder>
Status: investigating
```

**Status update** — every 30 minutes until resolved, and at every decision point:

```
Update <N> — <UTC timestamp>
Step reached: <step>
RPO so far: <measured, or "unknown until verification query runs">
ETA: <best estimate, or "unknown — blocked on <decision>">
```

**Resolution**:

```
Resolved <UTC timestamp>.
Measured RPO: <>
Measured RTO: <>
Root cause: <link>
Follow-up tickets: <links>
```

## Drill cadence

ST-266's automated drills (the weekly RDS restore-verify task and the monthly ERPNext restore
drill) ran on AWS and were removed with it; nothing replaces them yet. A game-day at least annually
remains the intent; [`st-266-game-day-drill-report.md`](st-266-game-day-drill-report.md) is the
historical first drill and the template the next one should copy, once there are runbooks to drill.
[`cross-tenant-tabletop-exercise.md`](cross-tenant-tabletop-exercise.md) is the tabletop for the
SEV1 cross-tenant scenario.

## Decision framework common to every scenario

The first decision is always the one that wastes the most time when it goes wrong: **is this
actually the scenario it looks like?**

1. Confirm scope before acting — a database connection failure that is actually a pooler or
   credentials problem is not instance loss. Check the fly apps (`fly status`, `fly logs`) and the
   provider's status page before reaching for any restore.
2. Confirm blast radius before choosing a mechanism — a single school's bad data is not an
   instance-level event; restoring the whole database to fix one school's rows rolls back every
   other school's writes since the restore point.
3. Confirm this isn't a regional or provider-wide event wearing a smaller scenario's clothes — if a
   managed service is down across the region, a restore inside that same region won't help.
