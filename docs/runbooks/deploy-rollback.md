# Deploy + rollback runbook

Source of the resources this doc describes: [`infra/deploy`](../../infra/deploy) (ECS Fargate
task-definition/service manifests, one pair per service, and the `render`/`deploy`/`rollback`
scripts that apply them). `infra/deploy/README.md` covers what each manifest field is and why;
this doc is the operational walkthrough — deploying, rolling back, and verifying the two
acceptance criteria — plus what's still missing to actually run any of it, which is more than
usual: see "Status" immediately below before reading further as if this were exercisable today.

## Status

**Not runnable yet.** `infra/deploy/README.md`'s "Known gaps / prerequisites" is the authoritative
list; the short version: no ECS cluster, execution role, or ALB target group exists anywhere in
`infra/terraform`, and `modules/registry`'s ECR repository policy actively denies pulls to any
principal other than `ci_push`/`deploy_pull` — the ECS task execution role is neither, so it will
be denied until that policy is widened. Everything below describes the intended flow and is
written to be accurate once those prerequisites land, in the same spirit
`docs/runbooks/supply-chain-security.md` and `docs/runbooks/secrets-conventions.md` already
describe mechanisms ahead of the infrastructure that uses them.

## Deploying

Building, pushing and signing an image is `docs/runbooks/supply-chain-security.md`'s job, not
this doc's — start here once an image is signed and sitting in ECR.

```bash
cd infra/deploy
./scripts/deploy.sh api staging "$(git rev-parse --short HEAD)"
```

What it does, in order:

1. Resolves the image's ECR URL from `terraform output registry_repository_urls` and verifies its
   cosign signature against `registry_signing_key_alias` — refuses to proceed if verification
   fails (`docs/runbooks/supply-chain-security.md`'s "pull, verify, reject if unsigned" step,
   finally implemented rather than just documented).
2. Renders `ecs/api/task-definition.json.tpl` (`environments/staging.env` + live `terraform output`
   values) and registers it as a new task-definition revision.
3. Renders `ecs/api/service.json.tpl` and either creates the service (first deploy) or updates it in
   place with the new revision, `--force-new-deployment`.
4. `aws ecs wait services-stable`, printing elapsed seconds when it returns.

Repeat for `realtime` and `workers` — there is no "deploy everything" wrapper; each service is
built, signed and deployed independently, and nothing here assumes they move in lockstep.

## Rolling back

Two distinct mechanisms, for two distinct failure shapes:

**A deploy that never becomes healthy** (new revision crash-loops, or never passes its container
health check) — no operator action needed. Every `service.json.tpl` sets
`deploymentConfiguration.deploymentCircuitBreaker: { enable: true, rollback: true }`; ECS detects
the failure to stabilize and reverts to the previous revision on its own. Watch it happen:

```bash
aws ecs describe-services --cluster "$ECS_CLUSTER" --services studafy-staging-api \
  --query 'services[0].deployments[].{status:status,taskDef:taskDefinition,rolloutState:rolloutState}'
```

**A deploy that passes health checks but is wrong some other way** (bad business logic, a
migration mismatch, anything a `/healthz`/`/readyz` 200 can't see) — manual rollback:

```bash
cd infra/deploy
./scripts/rollback.sh api staging          # rolls back one revision by default
./scripts/rollback.sh api staging 41       # or to a specific revision number
```

`rollback.sh` looks up the service's current task-definition revision, confirms the target
revision still exists (`aws ecs describe-task-definition`, so a typo'd revision number fails
before touching the live service, not mid-rollback), points the service at it with
`--force-new-deployment`, waits for `services-stable`, and prints the elapsed wall-clock time.

## Verifying the acceptance criteria

**"Rolling deploy in staging keeps availability (0 failed synthetic checks during deploy)"** — run
a synthetic check loop against the ALB in one terminal while `deploy.sh` runs in another:

```bash
DOMAIN="$(terraform -chdir=infra/terraform output -raw edge_domain_name)"
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/healthz")
  ts=$(date +%H:%M:%S)
  [ "$code" = "200" ] || echo "$ts FAILED: $code"
  sleep 1
done
```

```bash
# separate terminal
cd infra/deploy && ./scripts/deploy.sh api staging "$NEW_IMAGE_TAG"
```

Zero `FAILED` lines during the deploy is the criterion. This is a direct consequence of
`minimumHealthyPercent: 100` (staging/prod — see `environments/staging.env`): ECS never drops
below `desiredCount` healthy tasks behind the target group during the rollout, because it starts
and health-checks replacements before stopping the tasks they replace.

**"Rollback to previous image in <5 min demonstrated"**:

```bash
time ./scripts/rollback.sh api staging
```

`rollback.sh` itself prints elapsed seconds (`rollback complete in Ns`); `time` is redundant
confirmation. This is measured, not asserted — there's no hardcoded "we're done in under 5
minutes" anywhere in the scripts. For context on why it's realistically fast:
`healthCheckGracePeriodSeconds: 30` plus a 10s `startPeriod`/30s `interval`/3 `retries` container
health check means a task can be confirmed healthy in well under a minute once it's running; `aws
ecs wait services-stable` polls every 15s. The 5-minute budget is generous relative to those
numbers for a `desiredCount` of 2–3, not a target the configuration is tuned to just barely hit.

## Troubleshooting

A task that registers but never goes healthy:

```bash
aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$(aws ecs list-tasks --cluster "$ECS_CLUSTER" \
  --service-name studafy-staging-api --query 'taskArns[0]' --output text)" \
  --query 'tasks[0].{lastStatus:lastStatus,healthStatus:healthStatus,stoppedReason:stoppedReason}'

aws logs tail "/studafy-staging/ecs/api" --follow   # awslogs-group from task-definition.json.tpl
```

A service stuck `PENDING` at the ECR pull step specifically (`CannotPullContainerError` in
`stoppedReason`) is most likely prerequisite #1 in `infra/deploy/README.md`'s "Known gaps" — the
registry's `Deny` statement not yet widened to include the execution role.

## Known gaps

See `infra/deploy/README.md`'s "Known gaps / prerequisites" — not duplicated here to avoid the two
drifting apart. The one-line summary: this runbook is accurate for the deploy/rollback _mechanics_,
but nothing in `infra/terraform` yet provisions the cluster, execution role, or target groups these
scripts point at, and the ECR repository policy needs a scoped widening before the execution role
can pull at all.
