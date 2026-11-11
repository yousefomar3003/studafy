# Infrastructure map

Everything Studafy needs outside application code: container images, the fly.io app configs,
operator tools, and load tests. Each subdirectory has its own README with the detail; this page is
the index. `infra/` is not a Bun workspace (only `infra/load-tests` has its own `package.json`).

Production runs on fly.io with managed services around it: Postgres on Supabase, Redis on Redis
Cloud, files on Cloudflare R2, email through Resend, errors in Sentry, and logs and traces in Axiom.
Nothing runs on AWS. The retired AWS stack (Terraform, ECS deploy scripts, the self-hosted
Prometheus/Grafana/Loki/Tempo images) is in git history before the commit that removed it.

## Layout

```
infra/
├── docker/       — the app, migrations, ClamAV, and ERPNext Dockerfiles + baked-in config
├── fly/          — one fly.toml per production app, and the production runbook
├── erpnext/      — ERPNext seed and provisioning scripts baked into the erpnext image
├── tools/        — operator tooling run by hand against a database
└── load-tests/   — k6 load scenarios (ST-248)
```

| Path                                              | What lives there                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`docker/`](./docker/README.md)                   | One `<image>.Dockerfile` per image (`api`, `realtime`, `workers`, `web`, `migrations`, `clamav`, `erpnext`) and their config. |
| [`fly/`](./fly/README.md)                         | `api`, `realtime`, `workers`, `scanner`, `web`, `migrate`, and `log-shipper` app configs; secrets, deploys, observability.    |
| [`erpnext/seed/`](./erpnext/seed/README.md)       | `provision.py` (site setup, integration user, webhooks) and the synthetic demo fixtures.                                      |
| [`tools/integrity/`](./tools/integrity/README.md) | Per-tenant, read-only integrity checks with a JSON report, plus a self-verifying corruption drill.                            |
| [`load-tests/`](./load-tests/README.md)           | k6 scenarios (morning attendance peak, results-day read storm, Ask AI concurrency), thresholds, and a regression comparer.    |

## Environments

| Environment | `APP_ENV`, origin                       | Deployed by                                                                  |
| ----------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| local       | `development`, `http://localhost:5180`  | `compose.yml` / `bun run dev`                                                |
| prod        | `production`, `https://app.studafy.com` | `fly-production-deploy.yml` (manual, gated by the `prod` GitHub Environment) |

Production secrets live in the `prod` GitHub Environment; every deploy copies them to the fly apps.
See [`fly/README.md`](./fly/README.md).

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
another local project uses 5173. ERPNext runs from `db/compose.yml` (`bun run erpnext:up`).

## Root `scripts/`

| Script                   | Purpose                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `ci-local-db.sh`         | Mirrors CI's `database-migrations` job against a disposable local Postgres.                                                |
| `ci-local-containers.sh` | Mirrors `containers.yml`'s build-scan matrix (size budgets, Trivy if installed; skips erpnext unless `INCLUDE_ERPNEXT=1`). |
| `check-drift.sh`         | Regenerates all codegen artifacts locally so a broken generator is caught before CI.                                       |
| `eslint-staged.ts`       | Pre-commit `eslint --fix` over staged files, per workspace package.                                                        |

## How a change flows

1. **Pull request.** `ci.yml` (tests, database migrations + RLS coverage audit, security scans,
   ...) and `containers.yml` (builds, size-checks, and Trivy-scans the app, migrations, clamav, and
   erpnext images).
2. **Deploy.** `fly-production-deploy.yml`, run by hand: copies the `prod` secrets to the fly apps,
   runs migrations as a one-off machine (a failure releases nothing), then deploys each app. Schema
   changes are never rolled back, so migrations must stay backward-compatible.

Details: [`fly/README.md`](./fly/README.md).

## Where to change X

| To...                       | Change                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add an env var to a service | The app's `src/env.ts` (`apps/api`, `apps/workers`, `apps/realtime`); `fly/<app>.toml` `[env]`, or a `prod` secret plus the deploy workflow's secret list; `compose.yml` for local. |
| Add a migration             | The next six-digit file in `db/migrations` (`000048` is a permanent gap; never reuse it). See `docs/database/migration-policy.md`.                                                  |
| Add an image                | `docker/<name>.Dockerfile` (+ `docker/<name>/` config), a `fly/<app>.toml` if it ships, and the `containers.yml` matrix.                                                            |
