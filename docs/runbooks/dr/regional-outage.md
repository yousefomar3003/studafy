# Scenario 5: Regional outage

`eu-central-1` — every environment's home region (`aws_region` in each `environments/<env>/<env>.tfvars`)
— is degraded or unavailable at the AWS-region level: not one instance, the whole region. Every
other scenario in this directory assumes the region itself is healthy; this is the one where it
isn't.

Mechanism source: [`infra/terraform/modules/backup/replication.tf`](../../../infra/terraform/modules/backup/replication.tf)
(`aws_db_instance_automated_backups_replication`, continuously shipping the WAL-based backup stream
into `var.backup_dr_region`, default `eu-west-1`). Comms templates: [README.md](README.md).

## RPO / RTO target

If executed the moment the continuous replication stream is current: same seconds-to-low-minutes
RPO as scenario 1, since it's the same underlying WAL stream, just shipped to a second region.
**RTO: undrilled and, as of this drill, not currently achievable at all** — see the gap below. It
is not simply "same as scenario 1 but slower"; today there is nowhere to restore _to_.

## The gap this scenario exists to name: the DR region has no network in it

`replication.tf` ships the backup stream into `eu-west-1` using a second AWS provider alias
(`aws.dr`, `providers.tf`). Checking what else in `infra/terraform/main.tf` uses that provider
alias: **nothing.** `module.network` — the VPC, subnets, security groups every RDS instance needs a
home in — is instantiated exactly once per environment, in `eu-central-1`, with the default
provider. There is no `eu-west-1` VPC, no subnet group, no security group anywhere in this repo's
Terraform. `RestoreDBInstanceToPointInTime` against a replicated automated backup requires a
`--db-subnet-group-name` in the target region to restore into — **one does not exist**, and cannot
be created by hand quickly during an actual regional outage; standing up even a minimal VPC +
subnets + subnet group is itself a `terraform apply`, which needs the DR region's own state
bucket/backend to exist too (see [full-infrastructure-loss.md](full-infrastructure-loss.md) for
that mechanism), none of which has been provisioned.

**Practical consequence**: today, this scenario's data is safe (the replication stream itself works
— `replication.tf` — and `terraform validate` confirms the module composes correctly), but there is
no path to actually _serve_ it from `eu-west-1` without first doing a meaningful amount of
infrastructure work that has never been planned as its own deliverable, let alone drilled.

## Detection

AWS's own status page / a region-wide CloudWatch/health-check pattern across every service in
`eu-central-1` simultaneously — no in-repo alarm distinguishes "one instance is down" from "the
region is down"; today a responder has to infer it from multiple unrelated alarms firing at once
plus AWS's own status signals.

## Owner

Incident commander for this scenario is necessarily a wider role than the routine data-plane
operator — a regional outage affects every service this repo owns, not just the database plane;
treat it as an all-hands declaration, not a single-runbook response.

## Decision points

1. **Is this really regional, or one service's outage that looks regional?** Confirm against AWS's
   own health dashboard before declaring — see [README.md](README.md)'s decision framework, point
   3, run in reverse (don't over-declare a regional event either).
2. **Wait it out, or fail over?** AWS regional outages are typically measured in hours, not days;
   given the infrastructure gap above, standing up `eu-west-1` from nothing is very likely _slower_
   than waiting for `eu-central-1` to recover, except for the longest outages. This is a real
   business decision, not a mechanical one — document the reasoning in the status update either way.
3. **If failing over: how much new infrastructure is acceptable to build under incident pressure?**
   The honest answer today is "all of it" (network, subnet groups, security groups, at minimum) —
   which argues strongly for doing this work _before_ the next drill, not during a real outage. See
   Known gaps.

## Procedure (aspirational — documents the mechanism, not a runnable-today sequence)

**1. Stand up minimum viable network in `eu-west-1`.** Not built by this ticket. At minimum: a VPC,
private subnets across ≥2 AZs, a DB subnet group, a security group admitting the restore task.
Fastest realistic path: a scoped Terraform module reusing `modules/network`'s shape with
`aws.dr`-provider resources, applied against a new `eu-west-1` state backend
([full-infrastructure-loss.md](full-infrastructure-loss.md)'s backend-bootstrap steps, pointed at
the DR region).

**2. Restore from the replicated automated backup**, once step 1 exists:

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-automated-backups-arn "<ARN of the replicated automated backup in eu-west-1>" \
  --target-db-instance-identifier studafy-prod-postgres \
  --db-subnet-group-name "<from step 1>" \
  --vpc-security-group-ids "<from step 1>" \
  --region eu-west-1 \
  --use-latest-restorable-time
```

The replicated automated backup's ARN is discoverable via `aws rds describe-db-instance-automated-
backups --region eu-west-1` once step 1's IAM/network context exists to run that call from — not
independently confirmed against real output, since nothing has been applied.

**3. Repeat for MariaDB** if the ERPNext plane is in scope, same mechanism
(`aws_db_instance_automated_backups_replication.mariadb`, count-gated on `erpnext_plane_enabled`).

**4. Point the application at the new region.** No compute tier, ALB, or DNS failover plan for this
exists in `eu-west-1` either — `module.edge`/`module.compute`/`module.dns` are all `eu-central-1`-
only today. This is a second, larger gap than the database restore itself.

## Rollback / abort criteria

Given the infrastructure gap, the realistic abort criterion is: **if step 1 alone is projected to
take longer than waiting for `eu-central-1` to recover, don't fail over** — re-evaluate decision
point 2 continuously rather than committing irreversibly to a slower path.

## Known gaps

- **No network of any kind exists in the DR region.** The single largest gap this whole drill
  found. Everything downstream of it (subnet groups, security groups, compute, edge, DNS) is
  blocked on this.
- **No cross-region copy of the monthly locked vault** either (`modules/backup/README.md`'s own
  Known gaps) — scenario 4's mechanism doesn't help here if the compliance-mode vault itself is
  `eu-central-1`-only and the region is what's down.
- No DNS/traffic-failover plan (Route 53 health-check failover routing, or equivalent) exists —
  `module.dns` provisions one zone, no multi-region routing policy.
- This scenario has never been drilled even at the "does the mechanism work" level scenario 1's
  weekly job provides — there is no equivalent recurring exercise for cross-region restore at all.
