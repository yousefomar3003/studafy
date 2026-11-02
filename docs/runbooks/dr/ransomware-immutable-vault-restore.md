# Scenario 4: Ransomware or compromised prod credentials

Every credential anything in this repo's request path uses day-to-day — the Postgres/MariaDB master
credentials, the ECS execution role, any task role, `deploy_pull` — is compromised or acting
maliciously, and you cannot trust the live databases, their same-region continuous-backup stream,
or the cross-region replica of that same stream (an attacker with write access to the primary could
have corrupted data that then replicated everywhere, including into "backup"). This is the scenario
the monthly **immutable, Vault-Locked** AWS Backup snapshot exists for — the one copy nothing in the
day-to-day request path can reach or delete, by design.

Mechanism source: [`infra/terraform/modules/backup/main.tf`](../../../infra/terraform/modules/backup/main.tf)
(`aws_backup_vault` + `aws_backup_vault_lock_configuration`, Compliance mode). Policy:
`docs/architecture/SAD_30_backup_policy.md`'s "What 'immutable' and 'inaccessible with prod
credentials' actually mean here". Comms templates: [README.md](README.md).

## RPO / RTO target

**RPO: up to one calendar month** — the vault holds one snapshot per month
(`backup_plan_monthly_schedule`), not a continuous stream; that's the tradeoff for a copy no
day-to-day credential can touch. This is explicitly **not** the primary RPO path
(`SAD_30_backup_policy.md`'s table) — it's the last resort when the primary path is itself the
thing you can't trust. **RTO: undrilled, unbounded.** `modules/backup/README.md`'s own Known gaps
says it plainly: "an actual `aws backup start-restore-job` against a locked recovery point has not
been run in this repo." Nothing below has been exercised.

## The gap this scenario exists to name: nobody can run this today, even legitimately

`main.tf`'s design is deliberate: **no prod IAM identity is granted any `backup:*` permission
anywhere in this repo.** The only role that can touch the vault
(`aws_iam_role.backup_service`) trusts exclusively the `backup.amazonaws.com` service principal —
no human or application identity can assume it. That's correct for "inaccessible with prod
credentials" as a security property. It also means: **when this scenario is real, the first thing
an operator needs is a credential that today does not exist for anyone** — a break-glass identity
with `backup:StartRestoreJob`/`backup:DescribeRestoreJob`/`backup:ListRecoveryPointsByBackupVault`
scoped to this vault, provisioned _before_ the incident (it cannot be granted at incident time by a
credential that's itself potentially compromised — see decision point 1).

## Detection

No automated signal — this scenario is declared by a human (security team, an anomaly in access
logs, a ransom note, discovering the primary and its replicas are all compromised) then confirmed,
never by a CloudWatch alarm.

## Owner

Incident commander for this scenario should default to whoever owns security escalation, not the
routine data-plane operator — compromised-credential handling is a security incident with a DR
component, not a DR incident that happens to involve credentials. `docs/runbooks/security/` doesn't
currently define this role either; treat the IC as this runbook's Known-gaps item until it does.

## Decision points

1. **Do not restore using the credentials you suspect are compromised.** If the compromise reaches
   your Terraform-apply/root credential, an attacker could have already modified `main.tf` itself
   within `vault_lock_changeable_for_days` (default 3 — `SAD_30_backup_policy.md`'s own caveat) or
   provisioned a second, unlocked path. Restoring with a credential from the same blast radius you
   don't yet trust doesn't fix that. This needs an identity/session established _outside_ the
   suspected compromise — which, per the gap above, doesn't exist yet as a pre-provisioned
   break-glass role.
2. **Which recovery point?** One per month, `delete_after = vault_lock_min_retention_days` (default
   400 days). Pick the most recent one that predates the compromise — the vault has no
   "point-in-time" granularity, only whichever monthly snapshots exist.
3. **Restore where?** Never restore into the same subnet/security-group footprint the compromised
   credentials could already reach, until the compromise itself is understood and closed — otherwise
   the restored copy is exposed to the same attack path immediately.

## Procedure (undrilled — treat every step as needing verification, not as a known-good script)

**1. Provision (or locate, if pre-provisioned per the gap above) a restore-capable identity.**

```bash
# Minimum policy shape needed — does not exist as a pre-provisioned role today:
# backup:StartRestoreJob, backup:DescribeRestoreJob, backup:ListRecoveryPointsByBackupVault
# scoped to arn:aws:backup:eu-central-1:<account>:backup-vault:studafy-prod-monthly-locked
```

**2. Find the recovery point.**

```bash
VAULT="$(terraform -chdir=infra/terraform output -raw backup_monthly_locked_vault_name)"
aws backup list-recovery-points-by-backup-vault --backup-vault-name "$VAULT" --region eu-central-1
```

**3. Start the restore job**, into network isolation per decision point 3 (a fresh subnet group
with no route to the compromised footprint — this repo has no such subnet group pre-built; standing
one up is part of this step, not a prerequisite that already exists):

```bash
aws backup start-restore-job \
  --recovery-point-arn "<arn from step 2>" \
  --iam-role-arn "<the backup_service role, or an equivalent restore-scoped role>" \
  --resource-type RDS \
  --metadata '{"target-db-instance-identifier":"studafy-prod-postgres-vault-restore","db-subnet-group-name":"<isolated subnet group>","no-multi-az":"false"}' \
  --region eu-central-1
```

The exact `--metadata` keys AWS Backup expects for an RDS restore-from-snapshot are documented by
AWS, not by this repo — **verify the current key set against AWS's own `start-restore-job`
reference before running this for real**; it has never been run here to confirm.

**4. Poll and verify**, same shape as scenario 1's step 3-4, once available.

**5. Do not cut real traffic over automatically.** Unlike scenarios 1-3, this scenario implies a
security incident is still being contained — restoring data is necessary but not sufficient;
coordinate the actual cutover with whoever is closing the credential-compromise path, so restored
data doesn't immediately face the same attacker.

## Rollback / abort criteria

If step 1's break-glass identity itself cannot be established outside the suspected compromise,
**stop and escalate** — this is the scenario where "just restore it" is the wrong instinct; the
open security incident has to be contained first or the restore is compromised again immediately.

## Known gaps

- **No break-glass IAM role exists.** This is the single biggest gap in this entire DR program —
  every other scenario's gap is "undrilled"; this one is "unexecutable by anyone, today, even with
  good intentions." Highest-priority follow-up ticket from this drill.
- No isolated subnet group to restore into exists.
- `start-restore-job`'s `--metadata` shape for this repo's RDS engines has never been confirmed
  against a real vault.
- No defined security-incident-commander role to pair with the data-plane operator for this specific
  scenario.
