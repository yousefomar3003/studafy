# Deploy manifests: `apps/api`, `apps/realtime`, `apps/workers`, migrations, the ERPNext plane

ECS Fargate task-definition and service manifests, one per service per concern, plus the scripts
that render and apply them. Target platform and why it's ECS (not Kubernetes or Compose), and why
`apps/web` isn't here: see "Why ECS" and "Why not `apps/web`" below.

**Read "Known gaps / prerequisites" before running anything in `scripts/`.**

## Layout

```
infra/deploy/
├── ecs/
│   ├── api/{task-definition,service}.json.tpl
│   ├── realtime/{task-definition,service}.json.tpl
│   ├── workers/{task-definition,service}.json.tpl
│   └── migrations/task-definition.json.tpl    — one-off task, no service
├── environments/{dev,staging,prod,preview}.env    — see "Environment files" below
├── scripts/                                       — see "Scripts" below
├── preview/    — per-PR preview: two-container task-definition template + its test, nginx.conf, web.Dockerfile
├── erpnext/
│   ├── seed/      — synthetic seed fixtures for the ERPNext plane's seed tenant (see its own README)
│   └── backup/    — erpnext-backup.sh (nightly) and erpnext-restore-drill.sh (monthly), baked into
│                    the erpnext image and run by modules/backup's scheduled tasks
└── task-definitions.test.ts    — renders the api/workers templates and checks every env file sets
                                  APP_ENV and WEB_ORIGIN
```

### Scripts

| Script                                              | What it does                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `render.sh`                                         | Renders one `.json.tpl` for a service + environment from `terraform output` and `environments/<env>.env`; prints JSON to stdout.                                         |
| `populate-env.sh`                                   | Fills the blank `ECS_*`/subnet/security-group/target-group lines of `environments/<env>.env` from `terraform output`, in place.                                          |
| `migrate.sh`                                        | Verifies the signed migrations image and runs it as a one-off Fargate task; a non-zero exit stops the deploy.                                                            |
| `deploy.sh`                                         | Verifies an image's cosign signature, registers a task-definition revision, and rolls `api`, `realtime`, or `workers` to it.                                             |
| `rollback.sh`                                       | Manual rollback of one service to a previous task-definition revision (default: current - 1).                                                                            |
| `annotate-deploy.sh`                                | Writes one line to `modules/monitoring`'s deploy log group (the dashboard's "Recent deploys" table).                                                                     |
| `rotate-app-secret.sh`                              | Rotates one key in a service's `app-secrets` container through Terraform, then rolls the service.                                                                        |
| `erpnext-new-site.sh`                               | One-shot `bench new-site` for one school on the ERPNext plane (optionally `--seed`).                                                                                     |
| `run-postgres-restore-verify.sh`                    | Operator wrapper: launches `modules/backup`'s Postgres restore-verify ECS task on demand (in-container script: `infra/docker/backup-verify/postgres-restore-verify.sh`). |
| `run-erpnext-restore-drill.sh`                      | Operator wrapper: launches `modules/backup`'s ERPNext restore-drill ECS task on demand (in-container script: `erpnext/backup/erpnext-restore-drill.sh`).                 |
| `preview-db.sh`, `preview-up.sh`, `preview-down.sh` | PR preview lifecycle; see "PR preview environments" below.                                                                                                               |

The ERPNext plane (`infra/terraform/modules/erpnext`) has no `ecs/erpnext/*.json.tpl` pair here —
unlike api/realtime/workers, its ECS task definitions and services are Terraform-owned directly
(`modules/erpnext/main.tf`), not rendered/applied by a script. See that module's README for why.
`scripts/erpnext-new-site.sh` is a different kind of script entirely: a one-shot `bench new-site`
job invocation, not a rolling service deploy.

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

## Environment files

`environments/<env>.env` is sourced by `render.sh` (`set -a`), so every key is available to the
templates' `${VAR}` placeholders. Values that `terraform output` can supply are never duplicated here.

| Key(s)                                                                                                                                          | Meaning                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECS_CLUSTER`, `ECS_EXECUTION_ROLE_ARN`, `PRIVATE_APP_SUBNET_IDS`, `APP_SECURITY_GROUP_ID`, `API_TARGET_GROUP_ARN`, `REALTIME_TARGET_GROUP_ARN` | Committed blank; filled by `populate-env.sh` from `terraform output` inside each workflow job.                                                                                                                    |
| `APP_ENV`                                                                                                                                       | The API's deploy tier (`development` / `staging` / `production`). Anything but `development` enforces `CORS_ALLOWED_ORIGINS` and an enforcing CSP.                                                                |
| `WEB_ORIGIN`                                                                                                                                    | The web app's public origin; must match `web_origin` in `infra/terraform/environments/<env>/<env>.tfvars`. Dev: `http://localhost:5180`; staging: `https://staging.studafy.com`; prod: `https://app.studafy.com`. |
| `OTEL_COLLECTOR_ENDPOINT`, `SENTRY_ENVIRONMENT`                                                                                                 | Tracing endpoint and Sentry environment name.                                                                                                                                                                     |
| `<SERVICE>_DESIRED_COUNT`, `_CPU`, `_MEMORY`, `_MIN_HEALTHY_PERCENT`, `_MAX_PERCENT`                                                            | Replica count, task size, and rolling-update thresholds per service.                                                                                                                                              |

The templates map `APP_ENV` and `WEB_ORIGIN` as follows: the api task gets `APP_ENV`,
`CORS_ALLOWED_ORIGINS=${WEB_ORIGIN}`, and `FRONTEND_URL=${WEB_ORIGIN}`; the workers task gets
`FRONTEND_URL=${WEB_ORIGIN}` (links in emails). `task-definitions.test.ts` fails if an env file
drops either key. `preview.env` is separate; see "PR preview environments".

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

`containerDefinitions[].secrets` injects Secrets Manager keys with the `<arn>:<key>::` syntax
(`docs/runbooks/secrets-conventions.md`). Today's templates use:

- **`api`**: `DATABASE_USER`/`DATABASE_PASSWORD`/`DATABASE_CA_CERT` from the PgBouncer secret,
  `REDIS_URL` from the Redis secret's `queue_url`, and `TAP_SECRET_KEY`/`TAP_WEBHOOK_URL`/`SENTRY_DSN`
  from `<name_prefix>/api/app-secrets`.
- **`workers`**: the same database and `REDIS_URL` (`queue_url`) keys, plus
  `STRIPE_SECRET_KEY`/`TAP_SECRET_KEY`/`TAP_WEBHOOK_URL`/`SENTRY_DSN` from its own app-secrets.
- **`realtime`**: `WS_JWT_SECRET` and `SENTRY_DSN` from its app-secrets, and `REDIS_URL` from the
  Redis secret's `pubsub_url`.
- **`migrations`**: `DATABASE_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` from the Postgres connection
  secret (it connects directly to RDS, not PgBouncer).

The Redis secret stores ready-made `queue_url`/`pubsub_url` connection strings, so no composition
step is needed in the task definition. The task definitions are the source of truth; check them
before relying on this list.

## Metrics scrape wiring (ST-259)

Every service's `task-definition.json.tpl` now also exposes a `metrics` port mapping (9464 —
`@studafy/observability`'s Prometheus-format `/metrics` endpoint, `packages/observability/src/
metricsServer.ts`) alongside its main port, and every `service.json.tpl` registers into a Cloud
Map `aws_service_discovery_service` via `serviceRegistries` so `infra/terraform/modules/monitoring`'s
Prometheus task can find every replica by DNS (`modules/monitoring/discovery.tf` — one A record
per task, not one shared load-balanced address, which is what a scraper needs and Service Connect
specifically doesn't give). `scripts/render.sh` resolves each service's own registry ARN the same
way it already resolves `SECRET_ARN` — live, via `terraform output -json
monitoring_metrics_discovery_service_arns | jq`, never duplicated into `environments/<env>.env`.
`migrations` has neither a port mapping nor a `serviceRegistries` entry — it's a one-off task, not
a long-running service Prometheus would ever have a reason to scrape.

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

`apps/web` has a Dockerfile (`infra/docker/web.Dockerfile`) and an ECR repository (it is in
`modules/registry`'s `image_repository_names` default), and `release.yml` builds and signs it — but
nothing here deploys it. Whether `apps/web` ships as a CDN-hosted static bundle (`modules/cdn`,
already provisioned) or a containerized nginx service is still undecided (see `staging-deploy.yml`'s
`smoke` comment). Authoring ECS manifests for it here would be picking that decision by default,
silently, from the wrong ticket. Out of scope until that's resolved.

## Staging auto-deploy pipeline (ST-255)

`.github/workflows/staging-deploy.yml` runs `migrate.sh` → `populate-env.sh` + `deploy.sh`
(api/realtime/workers, in parallel) → a post-deploy smoke check on every merge to `main`, with no human dispatch — the
continuous-delivery counterpart to `deploy.yml`'s manual, any-environment dispatch. Full runbook:
`docs/runbooks/deploy-rollback.md`'s "Staging auto-deploy" section. Two things worth knowing
without reading that doc:

- **A failed migration halts the pipeline before either `deploy.sh` call runs** — `migrate.sh`'s
  own non-zero exit does that (see its header comment); nothing new was needed for the "gate," only
  for turning that halt into a human-visible signal, which is what the workflow's `alert` step (a
  `gh issue create`) is for. No Slack/PagerDuty/SNS topic exists in this repo to page into yet —
  same gap `docs/runbooks/pgbouncer-conventions.md`'s "Known gaps" already flags for the
  `ClientsWaiting` alarm — so a GitHub issue is the interim alert: real, actionable, and zero new
  secrets, not a placeholder for a channel that doesn't exist.
- **A smoke failure rolls back the service images, not the migration.** `packages/db`'s migration
  runner has no "down" command (`cli.ts`'s command set is `migrate|status|validate|pending` plus
  the partition and `rls-coverage` maintenance commands) — migrations are forward-only by design, so `scripts/rollback.sh` reverting api/realtime/
  workers to their previous task-definition revision after a smoke failure can leave the schema
  ahead of the code it just rolled back to. This is why every migration in `db/migrations/` must
  stay backward-compatible with the previous release (expand/contract, additive-first) — a schema
  rollback story is future work, not something this pipeline attempts.

`infra/deploy/scripts/annotate-deploy.sh` is the pipeline's last step regardless of outcome: it
writes one line to `modules/monitoring`'s deploy log group, which the operations dashboard renders
as a "Recent deploys" table — the "deploy annotations appear in monitoring" acceptance criterion.

## Production deploy pipeline

`.github/workflows/prod-deploy.yml` is the manual, approval-gated production path — `workflow_dispatch`
only, never a merge trigger. It reuses the same scripts as staging (`migrate.sh` → `populate-env.sh` + `deploy.sh` →
`populate-env.sh` + `rollback.sh`) in the same order, and adds four things staging does not have:

- a `gate` job on the `prod` GitHub Environment, whose required-reviewers rule enforces the approval;
- a `synthetics` job that asserts `/healthz`/`/readyz` and the realtime probe stay green _during_ the
  rolling update, not just after — a non-200 mid-rollout fails it and triggers `rollback.sh`;
- a `verify` job that watches the api/realtime ALB target 5xx rate for a configurable window and
  auto-halts (failing the run, which triggers `rollback.sh`) on an error-rate regression;
- a `dora` job that emits deployment frequency / lead time / change-failure / time-to-restore to the
  `Studafy/DORA` CloudWatch namespace.

Full runbook: `docs/runbooks/deploy-rollback.md`'s "Production deploy" section.

## PR preview environments (ST-258)

`.github/workflows/pr-preview.yml` builds an ephemeral preview for every `preview`-labelled PR from
this repo: the `apps/web` bundle plus `apps/api` as **one FARGATE `run-task`** (two containers —
`preview/task-definition.json.tpl`), reachable on the task's own public IP at
`http://pr-<number>.<preview-domain>:8080`, backed by its own `preview_pr_<number>` database on a
shared preview Postgres with the demo tenant seeded in. `pr-preview-teardown.yml` removes it on
`pull_request: closed` and sweeps stale tasks hourly by TTL.

It is **not** a fourth `render.sh`/`deploy.sh` environment. `render.sh` exists to share the
dev/staging/prod `terraform output` set (PgBouncer, Redis, task roles, target groups) across those
three; a preview consumes none of it, so `preview-up.sh` does its own `envsubst` against a much
smaller variable set. What it deliberately drops relative to `staging-deploy.yml` — the ALB, image
signing, `NODE_ENV=production`, PgBouncer, an RDS database — and why, is the table in
`docs/runbooks/pr-preview-environments.md`, which is also the authoritative list of the eleven
`PREVIEW_*` handles in `environments/preview.env` that must be filled in before any of it runs.
Until then it is inert: `pr-preview.yml`'s `guard` job requires `vars.AWS_DEPLOYMENTS_ENABLED`
**and** the `preview` label, and every preview script exits early on a blank handle.

Scripts:

- `preview-db.sh <create|drop|url|exists> <pr>` — per-PR database lifecycle on the shared server,
  driven by the `PREVIEW_DATABASE_ADMIN_URL` secret. `create` drops-then-creates (a preview is
  ephemeral; every deploy starts on a clean schema so a long-lived PR never drifts and the seed's
  "already seeded" guard is never hit).
- `preview-up.sh <pr> <api-image> <web-image> <tag>` — stop any prior task for the PR, render +
  register the task definition, `run-task`, resolve the ENI public IP, UPSERT the Route 53 record,
  poll `/healthz` + `/api/healthz`.
- `preview-down.sh <pr>` — stop tasks, delete the DNS record, drop the database, deregister the
  task-definition revisions, then **re-check the first three and exit non-zero on any residue** —
  that failing exit is the "teardown verified" acceptance gate.

## Workflow inputs

- **`populate-env.sh` runs in every job that deploys or rolls back**: `deploy.yml`'s `deploy` job
  (after `terraform apply`), and the `deploy` and `rollback` jobs of both `staging-deploy.yml` and
  `prod-deploy.yml`, each before `deploy.sh`/`rollback.sh`. The committed env files keep those lines
  blank; nobody copies `terraform output` values by hand.
- **Bastion inputs come from repository variables.** `bastion_allowed_ssh_cidrs` and
  `bastion_key_name` have no default and are deliberately not in `*.tfvars`. `terraform.yml`'s plan
  job and `deploy.yml`'s apply step pass them as `TF_VAR_bastion_allowed_ssh_cidrs` and
  `TF_VAR_bastion_key_name` from the repository variables `BASTION_ALLOWED_SSH_CIDRS_<ENV>` (a JSON
  list, e.g. `["203.0.113.4/32"]`) and `BASTION_KEY_NAME_<ENV>` (an existing EC2 key pair name), with
  `<ENV>` = `DEV`, `STAGING`, or `PROD`.

## Known gaps / prerequisites

Gaps 1–3 below are now closed by `infra/terraform/modules/compute` (the "future compute-tier
module" this section used to describe as missing) — kept here, marked resolved, since this
section is what a reader lands on when a `scripts/deploy.sh` run fails and needs to know why.

1. ~~The ECR repository policy denies pulls to anyone but `ci_push`/`deploy_pull`.~~ **Resolved.**
   `modules/registry`'s `additional_pull_role_arns` input is now set to
   `[module.compute.execution_role_arn]` in the root module — the execution role is exempted from
   `DenyPullExceptCiPushAndDeployPull` by name.
2. ~~No ECS cluster, execution role, target group, or listener rule exists.~~ **Resolved.**
   `modules/compute` provisions the cluster, the shared execution role, and the `api`/`realtime`
   target groups + listener rules on `module.edge`'s HTTPS listener. Run
   `scripts/populate-env.sh <env>` after `terraform apply` to fill `environments/<env>.env`'s
   `ECS_CLUSTER`/`ECS_EXECUTION_ROLE_ARN`/`PRIVATE_APP_SUBNET_IDS`/`APP_SECURITY_GROUP_ID`/
   `API_TARGET_GROUP_ARN`/`REALTIME_TARGET_GROUP_ARN` lines in place — it used to be a manual
   `terraform output` copy-paste; now it's a script, and every deploy/rollback workflow job runs
   it (see "Workflow inputs").
3. ~~`infra/terraform/outputs.tf` doesn't export the two subnet/security-group values at the
   root.~~ **Resolved.** `private_app_subnet_ids` and `app_security_group_id` are now root
   outputs, which is exactly what `populate-env.sh` reads.
4. ~~No task role exists for any service.~~ **Resolved for `api` and `workers`.** Both now call
   AWS directly (S3 for files and report artifacts), so `modules/compute` provisions
   `compute_api_task_role_arn` and `compute_workers_task_role_arn`, which `render.sh` reads and the
   templates set as `taskRoleArn`. `realtime` still makes no AWS SDK call and correctly has no task
   role; give it one (and attach `secrets_service_iam_policy_arns.realtime`) if that changes.

5. **No IAM role has exactly the permissions `deploy.sh`/`migrate.sh` need.**
   `modules/registry`'s `deploy_pull` role (environment-scoped via GitHub OIDC) covers only the ECR
   pull + KMS verify half; the ECS (`RegisterTaskDefinition`/`UpdateService`/`CreateService`/
   `DescribeServices`) and `iam:PassRole` half this script's own header comment lists has no
   Terraform-managed role anywhere in this repo yet. `deploy.yml` and `staging-deploy.yml` both
   work around this today by reusing `AWS_APPLY_ROLE_ARN` (the terraform-apply identity, broader
   than either half needs); `prod-deploy.yml` does the same — least-privilege cleanup here is scoping `deploy_pull` up to cover the
   ECS half, or a new dedicated role, not something this ticket's workflow authored.

`scripts/deploy.sh` and `scripts/rollback.sh` are meant to work as written once `terraform apply`
and `populate-env.sh` have run against a real AWS account — they were exercised in this ticket
only against `bash -n` and rendered-JSON validation (no AWS account to register/run against; same
"written without an account to test against" caveat `modules/pgbouncer/README.md` and
`modules/registry/README.md` already carry, and that `modules/compute/README.md` and
`modules/erpnext/README.md` now carry too). See `docs/runbooks/deploy-rollback.md` for the full
deploy/rollback/verify walkthrough, and `docs/runbooks/environment-matrix.md` for the full
apply-to-verify runbook across all three environments.

## ERPNext + Frappe Education plane

Not part of the three services above — a separate deploy path, since `bench new-site` is a one-shot
job, not a rolling service deploy. `infra/deploy/scripts/erpnext-new-site.sh <staging|prod>
<site-hostname> [--seed]` creates one school's site on the plane
`infra/terraform/modules/erpnext` provisions. See that module's README for the plane's topology and
`infra/deploy/erpnext/seed/README.md` for what `--seed` actually loads (synthetic placeholder data,
not real anonymized records — this repo has no production data to anonymize).
