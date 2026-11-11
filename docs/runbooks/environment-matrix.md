# Environment matrix

What differs between the two environments Studafy has: `local` (a developer's machine) and `prod`
(fly.io). There is no staging, preview or dev tier: the AWS stack that defined them was retired, and
production runs on fly.io with Postgres on Supabase, Redis on Redis Cloud, files on Cloudflare R2,
email through Resend, errors in Sentry and logs in Axiom. `infra/README.md`'s "Environments" table
is the summary; [`infra/fly/README.md`](../../infra/fly/README.md) is the production runbook (apps,
secrets, domains, deploys). This doc only collects what differs between the two.

## Overview

| Environment | `APP_ENV`, origin                       | Runs on                                                     | Deployed by                                                                  |
| ----------- | --------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| local       | `development`, `http://localhost:5180`  | root `compose.yml` (or `bun run dev`), Vite on port 5180    | by hand                                                                      |
| prod        | `production`, `https://app.studafy.com` | fly.io, region `fra`, one fly app per service (`infra/fly`) | `fly-production-deploy.yml` (manual, gated by the `prod` GitHub Environment) |

## Data tier

| Resource | local                                           | prod                                                                                                                                       |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Postgres | `pgvector/pgvector:pg16` container (port 54330) | Supabase project `studafy-prod` (`eu-central-1`); services use the transaction pooler (port 6543), migrations connect directly (port 5432) |
| Redis    | Redis 7 container (port 6391)                   | Redis Cloud (`eu-central-1`, `noeviction`, AOF every second)                                                                               |
| Files    | as configured in `compose.yml`                  | Cloudflare R2, bucket `studafy-prod-files`, through the S3 API (`S3_REGION = "auto"`)                                                      |
| Email    | `EMAIL_DRY_RUN`                                 | Resend (`RESEND_API_KEY`; webhook `/email/webhooks/resend`)                                                                                |
| ERPNext  | `db/compose.yml` (`bun run erpnext:up`)         | not deployed — there is no ERPNext fly app                                                                                                 |

## Edge / DNS

| Environment | API base URL              | Browser-facing domains                                                    | TLS                                               |
| ----------- | ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| local       | `http://localhost:3000`   | `http://localhost:5180` (Vite) or `http://localhost:8080` (compose `web`) | none                                              |
| prod        | `https://api.studafy.com` | `studafy.com`, `www.studafy.com`, `app.studafy.com`, `school.studafy.com` | fly certificates (`fly certs add`), DNS at Vercel |

`api.studafy.com` is `studafy-core-api`; the four browser domains are all served by
`studafy-core-web`. The realtime socket is reached through the API's `/ws` route (fly-replay to
`studafy-core-realtime`), not a host of its own, and is off while live updates are deferred.
`CORS_ALLOWED_ORIGINS` (`api.toml`) and `WS_ALLOWED_ORIGINS` (`realtime.toml`) list the same browser
domains. See [`infra/fly/README.md#domains`](../../infra/fly/README.md#domains).

## Compute tier

| Service  | local (compose) | prod (fly app, machine size)                                                    |
| -------- | --------------- | ------------------------------------------------------------------------------- |
| api      | `api`           | `studafy-core-api`, shared-cpu-1x 1 GB, always on                               |
| realtime | `realtime`      | `studafy-core-realtime`, shared-cpu-1x 512 MB, scaled to zero                   |
| workers  | `workers`       | `studafy-core-workers`, shared-cpu-1x 2 GB, always on                           |
| web      | `web` (nginx)   | `studafy-core-web`, shared-cpu-1x 256 MB, always on                             |
| scanner  | —               | `studafy-core-scanner` (clamd), private Flycast address, started on demand      |
| migrate  | `migrations`    | `studafy-core-migrate`, a one-off machine per deploy                            |
| logs     | —               | `studafy-log-shipper`, ships every app's logs to Axiom (dataset `studafy-logs`) |

The `infra/fly/*.toml` files are the source of truth for these values.

## Verifying production

After a run of **Production deploy (fly.io)**:

- `curl https://api.studafy.com/readyz` answers 200 (the API's fly health check uses the same path).
- `fly status --app <app>` shows each always-on app with a started machine.
- `fly logs --app studafy-core-migrate --no-tail` ends with "database is up to date".
