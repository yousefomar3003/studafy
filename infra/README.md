# Infrastructure map

Everything Studafy needs outside application code: container images, ECS deploy manifests, AWS
Terraform, operator tools, and load tests. Each subdirectory has its own README with the detail;
this page is the index. `infra/` is not a Bun workspace (only `infra/load-tests` has its own
`package.json`).

## Layout

```
infra/
├── docker/       — the 14 Dockerfiles (app, DB tooling, ERPNext, observability, backup) + baked-in config
├── deploy/       — ECS task-definition/service templates, per-env deploy parameters, deploy scripts
├── terraform/    — AWS infrastructure (root stack + modules), plus the account bootstrap stack
├── tools/        — operator tooling run by hand against a database
└── load-tests/   — k6 load scenarios (ST-248)
```

| Path                                                        | What lives there                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docker/`](./docker/README.md)                             | One `<image>.Dockerfile` per image (`api`, `realtime`, `workers`, `web`, `migrations`, `erpnext`, `prometheus`, `grafana`, `alertmanager`, `otel-collector`, `tempo`, `loki`, `vector`, `backup-verify`) and a same-named folder for the config each one bakes in.                                 |
| [`deploy/`](./deploy/README.md)                             | `ecs/{api,realtime,workers,migrations}` templates, `environments/{dev,staging,prod,preview}.env`, `scripts/` (render, migrate, deploy, rollback, populate-env, restore-drill wrappers, previews, ...), `preview/`, `erpnext/{seed,backup}`.                                                        |
| [`terraform/`](./terraform/README.md)                       | Root stack (`main.tf` wires the modules in `modules/`: naming, network, redis, postgres, pgbouncer, secrets, storage, registry, dns, edge, cdn, compute, monitoring, logging, mariadb, erpnext, backup), `outputs.tf`, and `environments/<env>/{backend.hcl,<env>.tfvars}` for dev, staging, prod. |
| [`terraform/bootstrap/`](./terraform/bootstrap/README.md)   | Account-wide, apply-once stack: state buckets, the Route 53 zone, GitHub's OIDC provider, and the protected Terraform roles.                                                                                                                                                                       |
| [`tools/tenant-restore/`](./tools/tenant-restore/README.md) | Restore a backup to a scratch instance and extract one school's slice (runbook: `docs/runbooks/tenant-restore.md`).                                                                                                                                                                                |
| [`tools/integrity/`](./tools/integrity/README.md)           | Per-tenant, read-only integrity checks with a JSON report, plus a self-verifying corruption drill.                                                                                                                                                                                                 |
| [`load-tests/`](./load-tests/README.md)                     | k6 scenarios (morning attendance peak, results-day read storm, Ask AI concurrency), thresholds, and a regression comparer.                                                                                                                                                                         |

## Environments

| Environment | Terraform inputs                                | `deploy/environments/*.env` (`APP_ENV`, `WEB_ORIGIN`) | Deployed by                                  |
| ----------- | ----------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| dev         | `terraform/environments/dev/dev.tfvars`         | `development`, `http://localhost:5180`                | `deploy.yml` (manual)                        |
| staging     | `terraform/environments/staging/staging.tfvars` | `staging`, `https://staging.studafy.com`              | `staging-deploy.yml` (every merge to `main`) |
| prod        | `terraform/environments/prod/prod.tfvars`       | `production`, `https://app.studafy.com`               | `prod-deploy.yml` (manual, approval gated)   |
| preview     | none (shares no Terraform outputs)              | `preview.env` (`PREVIEW_*` handles)                   | `pr-preview.yml` for `preview`-labelled PRs  |

Each environment has its own S3 state (`terraform/environments/<env>/backend.hcl`); the state
buckets come from `terraform/bootstrap`, which is applied once per account before anything else.
Operator-specific bastion inputs are not in `*.tfvars`: CI reads them from the repository variables
`BASTION_ALLOWED_SSH_CIDRS_<ENV>` and `BASTION_KEY_NAME_<ENV>`. The image build and
deploy jobs only run when the repository variable `AWS_DEPLOYMENTS_ENABLED` is
`true`; Terraform plans only when `AWS_PLAN_ROLE_ARN` is set.

## Local stack: root `compose.yml`

The root [`compose.yml`](../compose.yml) builds the same `infra/docker` images CI ships and runs them
with `NODE_ENV=development`. Ports are published on `127.0.0.1` only.

| Service                        | Profile   | Host port    | Notes                                                                                       |
| ------------------------------ | --------- | ------------ | ------------------------------------------------------------------------------------------- |
| `postgres`                     | (default) | 54330        | Dev database, `pgvector/pgvector:pg16`, data in the `postgres-data` volume.                 |
| `redis`                        | (default) | 6391         | Dev Redis 7.                                                                                |
| `migrations`                   | (default) | —            | One-shot; runs `db/migrations` before `api`/`workers` start.                                |
| `api`                          | (default) | 3000         | Also serves the mock OAuth provider at `/mock-idp`.                                         |
| `realtime`                     | (default) | 3001         |                                                                                             |
| `workers`                      | (default) | —            |                                                                                             |
| `web`                          | (default) | 8080         | nginx serving the built bundle; sign in with "Continue with Mock".                          |
| `test-postgres` / `test-redis` | `test`    | 54329 / 6390 | Disposable tmpfs database for the test suites and CI (`bun run db:up` / `bun run db:down`). |
| `seed`                         | `seed`    | —            | `docker compose --profile seed run --rm seed` loads the demo tenant (`db/seeds/seed.ts`).   |

```bash
docker compose up -d --build --wait   # full stack on http://localhost:8080
bun run db:up                         # just the disposable test database
```

The Vite dev server (`apps/web`, outside compose) runs on port 5180 with `strictPort`, because
another local project uses 5173. ERPNext and the observability images are not part of compose.

## Root `scripts/`

| Script                   | Purpose                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `ci-local-db.sh`         | Mirrors CI's `database-migrations` job against a disposable local Postgres.                                                |
| `ci-local-containers.sh` | Mirrors `containers.yml`'s build-scan matrix (size budgets, Trivy if installed; skips erpnext unless `INCLUDE_ERPNEXT=1`). |
| `check-alert-rules.ts`   | The alerting invariants CI enforces on the Prometheus rule files (e.g. every alert links a runbook).                       |
| `check-drift.sh`         | Regenerates all codegen artifacts locally so a broken generator is caught before CI.                                       |
| `eslint-staged.ts`       | Pre-commit `eslint --fix` over staged files, per workspace package.                                                        |

## How a change flows

1. **Pull request.** `ci.yml` (tests, database migrations + RLS coverage audit, security scans,
   `bun test infra/deploy`, ...), `containers.yml` (builds, size-checks, and Trivy-scans the app,
   migrations, and erpnext images), and `terraform.yml` (`validate` for both stacks; `plan` per
   environment when `AWS_PLAN_ROLE_ARN` is set).
2. **Build and sign.** `release.yml` builds all 14 images, pushes them to ECR, attaches SBOM and
   provenance, and cosign-signs them. It runs for dev from `build-and-sign.yml` on every merge to
   `main`, and as the first job of the staging and prod pipelines.
3. **Deploy.** `staging-deploy.yml` (every merge to `main`) and `prod-deploy.yml` (manual, approval
   gated) run `migrate.sh` (signed migrations image as a one-off Fargate task; a failure halts
   everything), then `populate-env.sh` + `deploy.sh` per service (api, realtime, workers), then
   post-deploy checks (staging: a smoke job; prod: synthetics during the rollout and an ALB 5xx
   watch). A failed check runs `populate-env.sh` + `rollback.sh` for each service. Schema changes are never rolled back, so
   migrations must stay backward-compatible. `deploy.yml` is the manual any-environment path that
   also runs `terraform apply` first.

Details: [`deploy/README.md`](./deploy/README.md) and `docs/runbooks/deploy-rollback.md`.

## Where to change X

| To...                       | Change                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add an env var to a service | The app's `src/env.ts` (`apps/api`, `apps/workers`, `apps/realtime`); `deploy/ecs/<service>/task-definition.json.tpl` (`environment`, or `secrets` with the key added in Terraform's `modules/secrets`); `deploy/environments/<env>.env` if it differs per environment; `compose.yml` for local. |
| Add a migration             | The next six-digit file in `db/migrations` (`000048` is a permanent gap; never reuse it). See `docs/database/migration-policy.md`.                                                                                                                                                               |
| Add an image                | `docker/<name>.Dockerfile` (+ `docker/<name>/` config), the `release.yml` build matrix, `image_repository_names` in `terraform/modules/registry`, and the `containers.yml` matrix if PRs should build it.                                                                                        |
| Add a Terraform module      | `terraform/modules/<name>/`, a `module` block in `terraform/main.tf`, root `variables.tf`/`outputs.tf` entries, and per-environment values in `terraform/environments/<env>/<env>.tfvars`.                                                                                                       |
