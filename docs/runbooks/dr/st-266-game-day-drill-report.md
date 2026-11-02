# ST-266 game-day drill report

Date: 2026-09-08. Scope: first execution of the game-day drill this ticket's acceptance criteria
call for, against the six runbooks in this directory.

## Result, up front

**The drill did not run against real infrastructure, and no real RPO/RTO number was measured.**
Not because the drill wasn't attempted — because there is no AWS account reachable from this
environment or any evidence one has ever been applied to. Reporting a measured RPO/RTO here would
mean fabricating one, which is worse than not having one. What follows is exactly what _was_
verified, what wasn't, and why — plus a gap backlog that itself satisfies "gaps ticketed", since the
gaps found are more concrete and more numerous than a clean pass would have surfaced.

## What blocked a live drill

- No `aws` CLI is installed anywhere on this machine's `PATH`.
- No AWS credentials are present in the environment (`AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, etc. all
  unset).
- `terraform state list` against `infra/terraform`'s real backend configuration fails with
  "Backend initialization required" — i.e. `terraform init -backend-config=environments/<env>/
backend.hcl` has never been run to completion against a live S3 state bucket from this checkout,
  and every module's own README independently confirms the broader fact: **this codebase has never
  been `terraform apply`'d against a real AWS account, in any environment.**
- The only running infrastructure on this machine is unrelated local dev tooling (a local
  `pgvector`/Postgres and Redis via Docker Compose for `apps/api`'s own test suite) — not this
  repo's AWS-hosted staging environment, and not a substitute for it; ERPNext's bench mechanics,
  RDS's PITR API, and AWS Backup's Vault Lock have no local-Docker equivalent worth pretending is
  the same drill.

This is consistent with, not contradictory to, `infra/terraform/README.md`'s own Status line and
every module README's "not exercised against a live AWS account" — ST-265 (the backup automation
this drill exercises) landed in the same state every other module is in.

## What was actually verified

1. **`terraform validate` passes for the whole configuration**, `module.backup` included:

   ```
   $ terraform init -backend=false && terraform validate
   Success! The configuration is valid.
   ```

   This confirms the module graph type-checks and every reference (`module.backup`'s inputs from
   `module.network`/`module.postgres`/`module.mariadb`/`module.storage`/`module.erpnext`, the
   `aws.dr` provider alias) resolves correctly. It does **not** confirm the resources it would
   create actually behave as described — that needs a real `apply`, which this drill could not run
   (see above). An offline `plan` (local-backend override, per `infra/terraform/README.md`'s
   documented pattern) was not completed in this sandbox either — `validate` is the one concrete,
   reproducible data point this drill produced.

2. **Every script each runbook's procedure depends on was read in full**, not summarized from
   memory: `postgres-restore-verify.sh`, `erpnext-backup.sh`, `erpnext-restore-drill.sh`,
   `postgres-restore-verify.sh` (the wrapper), `erpnext-restore-drill.sh` (the wrapper), and every
   `.tf` file `modules/backup` consists of. Every command in every runbook is either copied
   verbatim from one of those scripts (the automated-drill paths) or hand-derived from the same
   AWS/bench APIs those scripts already call (the real-incident cutover paths, which no script
   covers — see each runbook's own gaps).

3. **Cross-referencing what's wired versus what's documented surfaced gaps no amount of reading a
   single file would have** — specifically by diffing "what does `module.backup` output" against
   "what does root `outputs.tf` re-export", and "what provider aliases exist" against "what actually
   uses them". These are listed below, not asserted from the module's own (already honest) README,
   because they're new findings this drill made, not things ST-265 already flagged.

## Acceptance criteria — actual status

| Criterion                                                                 | Status                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drill restores staging from a prod-shaped backup, RPO ≤ 5 min / RTO ≤ 4 h | **Not met, not currently measurable.** No live environment to restore. The _mechanism_ (RDS PITR restore) is capable of the RPO target per `SAD_30_backup_policy.md`'s own numbers (seconds-to-low-minutes) and the _drill_ step of that mechanism has an observed 10-20 minute duration in this repo's own script comments — well inside 4h — but "capable per source review" is not "measured", and this report will not claim otherwise. |
| Gaps ticketed                                                             | **Met** — see backlog below.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Runbooks versioned in repo                                                | **Met** — six scenario runbooks + index, `docs/runbooks/dr/`.                                                                                                                                                                                                                                                                                                                                                                               |

## Gap backlog (filed as GitHub issues, label `dr-gap`)

Ordered by how much they block a _future_ live drill, most-blocking first.

1. **No AWS account has ever been applied to.** Every other gap below is secondary to this one —
   none of scenarios 1-6 can be genuinely drilled until `infra/terraform` is `apply`'d somewhere
   real. This is pre-existing (not introduced by ST-266) but is the actual reason this drill
   couldn't produce a number. [#278](https://github.com/yousefomar3003/studafy/issues/278)
2. **No break-glass IAM role for AWS Backup vault restores exists** (scenario 4). By the vault's own
   design, nobody — including whoever runs the next real drill — can call `backup:StartRestoreJob`
   today. Highest-priority gap that _is_ fixable independent of gap #1's timeline.
   [#279](https://github.com/yousefomar3003/studafy/issues/279)
3. **The DR region (`eu-west-1`) has no network in it at all** (scenario 5) — no VPC, no subnets, no
   subnet group. The cross-region backup replication (`replication.tf`) works; there is nowhere to
   restore it to. [#280](https://github.com/yousefomar3003/studafy/issues/280)
4. **No automated restore-verify drill exists for the MariaDB/ERPNext-instance plane** (scenario 2)
   — `restore_verify.tf` is Postgres-only; the monthly ERPNext drill restores a _site_, never the
   raw instance. [#281](https://github.com/yousefomar3003/studafy/issues/281)
5. **No RDS "instance unreachable" alarm** for either engine (scenarios 1, 2) —
   `modules/monitoring/main.tf` covers CPU/storage/replica-lag, not availability.
   [#282](https://github.com/yousefomar3003/studafy/issues/282)
6. **`--db-subnet-group-name`/`--vpc-security-group-ids` for Postgres, and the raw MariaDB instance
   identifier, aren't exposed as root Terraform outputs** (scenarios 1, 2) — an operator needs state
   access to find them today. [#283](https://github.com/yousefomar3003/studafy/issues/283)
7. **No script performs the real-incident cutover** for scenarios 1 or 2 — only the drill's
   restore-then-delete path is automated. Each runbook documents the manual sequence; nobody has run
   it. [#284](https://github.com/yousefomar3003/studafy/issues/284)
8. **The rename-based cutover (RDS endpoint DNS following instance identifier) has never been
   watched actually working against this repo's PgBouncer or ERPNext bench containers** — it's
   standard AWS practice, not confirmed here. [#285](https://github.com/yousefomar3003/studafy/issues/285)
9. **No consolidated list of imperative (non-Terraform) provisioning steps** needed after a
   from-scratch rebuild (scenario 6) — assembled ad hoc from each module's README for this drill;
   worth its own doc once run for real. [#286](https://github.com/yousefomar3003/studafy/issues/286)
10. **No security-incident-commander role is defined** to pair with the data-plane operator for
    scenario 4 specifically. [#287](https://github.com/yousefomar3003/studafy/issues/287)

## What the next drill needs, to actually produce a number

In order: (a) `infra/terraform apply` against a real `dev` or `staging` AWS account — this alone
unblocks everything else; (b) gap #2 (break-glass restore role) and #6 (root outputs) closed first,
since they're cheap and block even a basic scenario-1 dry run; (c) then re-run this drill's own
scenario-1 procedure for real, with a stopwatch, and replace this report's "not currently
measurable" line with an actual RPO/RTO pair.
