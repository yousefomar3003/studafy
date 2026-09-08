# Scenario 6: Full infrastructure loss

Every Terraform-managed resource for an environment is gone or unusable — a botched `terraform
destroy`, a deleted/corrupted state file with no way to reconcile it, someone force-deleting
resources out-of-band. **Scope**: this scenario assumes the AWS **account** and everything AWS-Backup-
Vault-Locked in it survives — only the resources Terraform manages (VPC, RDS, ECS, S3 app buckets,
…) are gone. If the account itself is gone, nothing in this repo recovers from that: there is no
second backup-owner account (`SAD_30_backup_policy.md`'s "What 'immutable'... actually mean here",
last paragraph) — that's a pre-existing, larger gap this runbook doesn't attempt to close.

Mechanism source: the entire `infra/terraform` root module (rebuild) plus either
[ransomware-immutable-vault-restore.md](ransomware-immutable-vault-restore.md)'s vault mechanism or
scenario 1/2's same-region PITR mechanism (data recovery), whichever backups actually survived
whatever destroyed the infrastructure. Comms templates: [README.md](README.md).

## RPO / RTO target

Depends entirely on which data-recovery path applies (decision point 2): same-region PITR restore's
seconds-to-low-minutes RPO if the source RDS instances' own backup retention survived, or the
monthly vault's up-to-one-month RPO if they didn't. **RTO: undrilled, and structurally the largest
of any scenario here** — it includes a full `terraform apply` (every module in
`infra/terraform/README.md`'s folder structure, in dependency order) before any data restore even
starts.

## Detection

Human-declared — a `terraform plan` showing every resource as "to be created" against state that
should show them as existing, or `aws` console/CLI confirming resources are simply gone.

## Owner

Incident commander for this scenario should be whoever owns `infra/terraform` changes generally
(the same reviewer(s) `main` branch protection would route infra PRs to) — this is the scenario
requiring the deepest familiarity with the full module graph, not primarily a data-restore
operation.

## Decision points

1. **Does the state bucket itself survive?** `infra/terraform/README.md`'s "Remote state and
   locking": one S3 bucket per environment (`studafy-tfstate-<env>`), versioned. If the bucket
   survives but resources were deleted out-of-band, `terraform plan` against existing state shows
   the drift directly and `apply` recreates only what's missing — much faster than a from-scratch
   rebuild. If the bucket itself is gone, this becomes a from-scratch rebuild (procedure below,
   from step 1) with no state to diff against.
2. **Which data survived?** Check both, in order of preference:
   - Same-region RDS backup retention (`postgres_backup_retention_days`/
     `mariadb_backup_retention_days`) — if the RDS instances were destroyed but their automated
     backups weren't (deleting an RDS instance without `--skip-final-snapshot`, or the automated
     backup's own retention window, can outlive the instance), a same-region PITR restore
     (scenario 1/2's mechanism) is faster and fresher than the vault.
   - The monthly locked vault (`aws_backup_vault.monthly`) — survives almost anything short of the
     account itself being gone, per its Compliance-mode design, but is up to a month stale.
3. **Rebuild into the same environment, or a fresh one?** Rebuilding `prod` in place (same
   `name_prefix`, same DNS zone) is almost always right — a fresh environment means re-doing DNS
   delegation, cert issuance, and every "which environment does this address" assumption throughout
   the codebase (`infra/terraform/README.md`'s environment-layout section).

## Procedure

**1. Re-create the state backend, if decision point 1 says it's gone** — the exact one-time,
out-of-band steps `infra/terraform/README.md`'s "Backend setup" section already documents (`aws
s3api create-bucket` + versioning + encryption + public-access-block). Not repeated here to avoid
the two drifting apart — follow that section verbatim.

**2. `terraform init` against the (re-created or surviving) backend:**

```bash
cd infra/terraform
terraform init -reconfigure -backend-config=environments/prod/backend.hcl
```

**3. Plan and review before applying** — even under incident pressure, a full-environment apply is
exactly the moment to actually read the plan output, not skip it:

```bash
terraform plan -var-file=environments/prod/prod.tfvars
```

If state survived (decision point 1), this plan should show only the actually-missing resources.
If state didn't survive, expect the entire module graph to plan as new — review it against
`infra/terraform/README.md`'s folder structure to sanity-check nothing is unexpectedly different
from what's committed.

**4. Apply.**

```bash
terraform apply -var-file=environments/prod/prod.tfvars
```

Every module here has its own "not exercised against a live AWS account" caveat
(`modules/*/README.md`) — a from-scratch `apply` of the full graph, in the exact dependency order
`main.tf` wires it, **has never actually been run**. This is the largest untested surface in this
entire drill.

**5. Restore data**, per decision point 2 — either scenario 1/2's PITR procedure (source instance
still has backup retention) or scenario 4's vault-restore procedure (only the monthly snapshot
survived), pointed at the newly-created instances from step 4.

**6. Re-run whatever imperative, non-Terraform provisioning steps the environment depended on** —
`infra/deploy/scripts/erpnext-new-site.sh` per school (ERPNext sites are created imperatively, not
by Terraform — `modules/backup/README.md`'s "What this module does not do"), and any other
one-time manual step every module's own README documents (e.g. `modules/postgres/README.md`'s
`metrics_reader` role creation).

**7. Verify** using each affected scenario's own verification steps (1/2/3/4 above) before
declaring resolved.

## Rollback / abort criteria

There is no meaningful "abort and go back" for this scenario — the prior state is what's already
gone. The equivalent caution: **don't `apply` against a plan you haven't actually reviewed**, and if
`plan` output looks wrong (unexpected deletions, a module you didn't expect to change), stop and
investigate before `apply` rather than after.

## Known gaps

- **A full from-scratch `terraform apply` of every module, in order, has never been run against a
  real AWS account.** This is true of every individual module already (each README says so
  independently); this scenario is the one place that fact compounds across all of them at once.
- Step 6's list of imperative, non-Terraform steps is assembled from each module's own README
  Known-gaps section — there is no single consolidated checklist today. Worth extracting into its
  own doc once this repo has run this procedure for real even once.
- No estimate exists for how long step 4 (full apply) actually takes — every module's plan/apply
  has only been validated offline (`terraform validate`, or `plan` against a local backend
  override), never timed against real AWS API latency across ~15 modules.
