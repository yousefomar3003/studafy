# Deploy manifests: `apps/api`, `apps/realtime`, `apps/workers`

ECS Fargate task-definition and service manifests, one per service per concern, plus the scripts
that render and apply them. Target platform and why it's ECS (not Kubernetes or Compose), and why
`apps/web` isn't here: see "Why ECS" and "Why not `apps/web`" below.

**Read "Known gaps / prerequisites" before running anything in `scripts/`.** Two of this repo's
existing resource policies actively block these manifests from working today, not just "nothing's
wired up yet" — see the ECR bullet below in particular.

## Layout

```
infra/deploy/
├── ecs/
│   ├── api/{task-definition,service}.json.tpl
│   ├── realtime/{task-definition,service}.json.tpl
│   └── workers/{task-definition,service}.json.tpl
├── environments/{dev,staging,prod}.env    — replica counts, cpu/memory, rolling-update thresholds
└── scripts/{render,deploy,rollback}.sh
```

One `task-definition.json.tpl` + `service.json.tpl` pair per service, because `aws ecs
register-task-definition` and `aws ecs create-service`/`update-service` are genuinely two separate
API calls with two different JSON shapes — collapsing them into one file would just mean the
scripts pick fields back apart before each call. No shared template/generator behind the three
services either: they're ~90% identical, but three explicit ~30-line JSON files are easier to read
and diff than a templating layer that produces them, for a set of files this small and this rarely
added to.

`.json.tpl`, not `.json`: every file contains unquoted `${VAR}` placeholders (e.g.
`"desiredCount": ${API_DESIRED_COUNT}`) that make it invalid JSON until `scripts/render.sh` runs
`envsubst` over it — `.json` would make this repo's own prettier pre-commit hook (which formats
every staged `*.json` file) try to parse it as JSON and fail. `scripts/render.sh` takes the
template path as an explicit argument, so it has no hardcoded extension assumption either way.

## Rolling update strategy (the ticket's core ask)

Every `service.json` sets:

```json
"deploymentConfiguration": {
  "maximumPercent": 200,
  "minimumHealthyPercent": 100,   // 50 in dev — see environments/dev.env
  "deploymentCircuitBreaker": { "enable": true, "rollback": true }
}
```

`minimumHealthyPercent: 100` + `maximumPercent: 200` (staging/prod): ECS starts new tasks
alongside the old ones and only stops an old task once its replacement passes the target group's
health check (api/realtime) or its container health check (workers) — the running task count never
drops below `desiredCount` during a deploy. That's what "0 failed synthetic checks during deploy"
requires. `deploymentCircuitBreaker` is ECS's own automatic rollback: if the new revision never
reaches a healthy steady state, ECS reverts to the previous one without an operator doing anything.
`scripts/rollback.sh` is the _manual_ path, for a deploy that passes health checks but is wrong in
some other way — see `docs/runbooks/deploy-rollback.md`.

## Probe mapping

`apps/api` and `apps/realtime` already define this contract (`apps/api/README.md`,
`apps/api/src/health.ts`): `/healthz` is liveness (process alive), `/readyz` is readiness (should
receive traffic — flips to `503` during shutdown so a load balancer drains in-flight requests).
That maps onto two distinct ECS-level checks, not one:

| Contract endpoint | ECS mechanism                                                          | Effect                                                                                                                |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/healthz`        | `containerDefinitions[].healthCheck` in `task-definition.json.tpl`     | ECS replaces a task the agent reports unhealthy, same command already in each service's Dockerfile `HEALTHCHECK`.     |
| `/readyz`         | ALB target group health check (not created by this ticket — see below) | Controls routing: a task that's alive but not ready (mid-shutdown) stops receiving new requests without being killed. |

`apps/workers` has neither endpoint (`infra/docker/README.md`: "no HTTP or IPC surface"). Its
`healthCheck` reuses the exact command its Dockerfile already runs (`bun healthcheck.ts` — opens a
raw TCP check against `REDIS_URL`), and it has no target group at all — it's never behind the ALB.

## env-from-secrets

`containerDefinitions[].secrets` injects from `infra/terraform/modules/secrets`'s per-service
`<name_prefix>/<service>/app-secrets` containers, `<arn>:<key>::` syntax (the convention
`docs/runbooks/secrets-conventions.md` already documented, ahead of any compute tier existing to
use it):

- **`realtime`**: `WS_JWT_SECRET` — real, wired, one-to-one (`apps/realtime/src/env.ts` reads
  exactly this key from exactly this secret).
- **`api`**: empty `"secrets": []`. `apps/api/src/env.ts` has no secret-shaped variable today
  (`NODE_ENV`, `PORT`, `HOST`, `SHUTDOWN_TIMEOUT_MS` only) — an empty array here is accurate, not
  an oversight.
- **`workers`**: empty `"secrets": []`, for the same reason as `api`.

**`REDIS_URL` is deliberately not wired**, for `realtime` or `workers`. Both read a single
`REDIS_URL` connection-string env var, but `modules/redis`'s secret stores separate fields
(`auth_token`, `primary_endpoint`, `reader_endpoint`, `port`, `tls`, ...) — `secrets-conventions.md`
already flags composing those into one string as "a task-definition-level concern... that belongs
to whatever ticket adds the compute module," which isn't fully this one either. ECS's `secrets`
field maps one Secrets Manager key to exactly one env var; it cannot compute a URL from five of
them. Closing this gap needs either `apps/realtime`/`apps/workers`' `env.ts` to accept split
`REDIS_HOST`/`REDIS_PORT`/`REDIS_AUTH_TOKEN` vars and compose the URL itself, or a small
container-level init step — an application change, not a manifest change, so it's not done here.
Same reasoning applies to `apps/api` and Postgres/PgBouncer: `apps/api/src/env.ts` has no database
variable at all yet, so there is nothing for this ticket to wire.

## Why ECS (not Kubernetes or Compose)

No EKS cluster, Swarm cluster, or any `kubernetes`/`ecs`/`fargate` resource existed in this repo
before this ticket except `infra/terraform/modules/registry` (ECR) — but the ALB's HTTPS listener
(`modules/edge`) is explicitly built with a target-group-less default action "so a future
compute-tier module can attach `aws_lb_target_group` + `aws_lb_listener_rule` resources without
editing this module" (`modules/edge/README.md`), `module.network` exports `app_security_group_id`
for the same future tier, and `docs/runbooks/supply-chain-security.md` says outright "ADR-004
references ECS as the likely direction." Every surrounding primitive is ECS-shaped; nothing in this
repo assumes Kubernetes or Docker Swarm, and standing up either from scratch here — a control
plane, an admission/secrets-injection story, a load-balancer controller — would be inventing
infrastructure this repo has given no other indication it wants, not "authoring manifests."

## Why not `apps/web`

`apps/web` has a Dockerfile (`infra/docker/web.Dockerfile`) but no ECR repository —
`modules/registry`'s `image_repository_names` default is `["api", "realtime", "workers"]`, on
purpose, because whether `apps/web` ships as a CDN-hosted static bundle (`modules/cdn`, already
provisioned) or a containerized nginx image hasn't been decided (`infra/docker/README.md`'s "Known
gaps"). Authoring ECS manifests for it here would be picking that decision by default, silently,
from the wrong ticket. Out of scope until that's resolved.

## Known gaps / prerequisites

Nothing in `scripts/` can succeed yet. In order of how blocking each one is:

1. **The ECR repository policy denies pulls to anyone but `ci_push`/`deploy_pull`.**
   `modules/registry/main.tf`'s `DenyPullExceptCiPushAndDeployPull` statement means the ECS task
   _execution_ role (a third IAM principal, distinct from both — the one Fargate itself assumes to
   pull the image at task launch) will be denied, full stop, however this is deployed. This isn't
   "not wired up yet" — it's an active `Deny` that has to be widened (add the execution role's ARN
   to that statement's exception list) before a task can ever start. That's a `modules/registry`
   change, out of this ticket's `infra/deploy` scope.
2. **No ECS cluster, execution role, target group, or listener rule exists.**
   `environments/*.env`'s `ECS_CLUSTER`, `ECS_EXECUTION_ROLE_ARN`, `PRIVATE_APP_SUBNET_IDS`,
   `APP_SECURITY_GROUP_ID`, `API_TARGET_GROUP_ARN`, `REALTIME_TARGET_GROUP_ARN` are blank — nothing
   in `infra/terraform` provisions them (`infra/terraform/README.md`'s status note; each is called
   out as "future compute-tier module" in `modules/edge/README.md` and `modules/network/outputs.tf`
   in spirit, if not literally exported yet).
3. **`infra/terraform/outputs.tf` doesn't export `module.network.private_app_subnet_ids` or
   `app_security_group_id` at the root** — only the module's own output does. `render.sh` doesn't
   attempt to fetch these two dynamically for that reason; they're plain manual entries in
   `environments/*.env` today. Adding the two root outputs is a one-line, low-risk follow-up but is
   an `infra/terraform` change, so it isn't bundled into this `infra/deploy`-scoped ticket.
4. **No task role exists for any service**, but none is referenced in `task-definition.json.tpl`
   either — none of `apps/api`/`apps/realtime`/`apps/workers` makes an AWS SDK call from
   application code today (secrets arrive via the execution role's injection, not app-level
   `GetSecretValue` calls), so `taskRoleArn` is correctly omitted, not forgotten. The moment any of
   the three starts calling AWS directly (e.g. presigned S3 URLs against `modules/storage`), it
   needs a task role — attach `secrets_service_iam_policy_arns.<service>` to it at that point
   (`docs/runbooks/secrets-conventions.md`).

Once 1–3 are resolved (compute-tier Terraform, a separate ticket), `scripts/deploy.sh` and
`scripts/rollback.sh` are meant to work as written — they were exercised in this ticket only
against `bash -n` and rendered-JSON validation (no AWS account to register/run against; same
"written without an account to test against" caveat `modules/pgbouncer/README.md` and
`modules/registry/README.md` already carry). See `docs/runbooks/deploy-rollback.md` for the full
deploy/rollback/verify walkthrough.
