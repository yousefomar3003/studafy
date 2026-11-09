# Production on fly.io

Production runs on fly.io instead of AWS ECS. Each service is its own fly app in `fra`
(Frankfurt), next to the managed services it uses:

| fly app                 | Config          | What                                                        |
| ----------------------- | --------------- | ----------------------------------------------------------- |
| `studafy-core-api`      | `api.toml`      | apps/api, public at `api.studafy.com`                       |
| `studafy-core-realtime` | `realtime.toml` | apps/realtime; reached through the API's `/ws` (fly-replay) |
| `studafy-core-workers`  | `workers.toml`  | apps/workers, no inbound traffic                            |
| `studafy-core-scanner`  | `scanner.toml`  | clamd, private (Flycast) only                               |
| `studafy-core-web`      | `web.toml`      | apps/web, public at `app.studafy.com`                       |
| `studafy-core-migrate`  | `migrate.toml`  | db migrations, run as a one-off machine                     |

Managed services: Postgres on Supabase (project `studafy-prod`, `eu-central-1`), Redis on Redis
Cloud (`eu-central-1`, `noeviction`, AOF every second), files on Cloudflare R2 (bucket
`studafy-prod-files`), email through Resend.

Every command below runs from the repository root.

## Database connections

The services connect through Supabase's **transaction** pooler (port 6543), which plays the part
PgBouncer played on AWS: every pool already runs `prepare: false` and nothing holds session state.
Migrations use the **session** pooler (port 5432). Both are `aws-1-eu-central-1.pooler.supabase.com`
with user `postgres.<project ref>`, over TLS verified against Supabase's root CA
(`DATABASE_CA_CERT`, downloaded from Project Settings → Database → SSL configuration).

The services log in as the project's `postgres` user, as they did with the RDS master user. Moving
them to a dedicated `NOBYPASSRLS` login is the open follow-up in
docs/security/S-01-database-role-verification.md.

## First-time setup

1. Create the apps (once):
   `fly apps create studafy-core-api` and the same for `-realtime`, `-workers`, `-scanner`, `-web`,
   `-migrate`.
2. Give the scanner a private address only: `fly ips allocate-v6 --private --app studafy-core-scanner`.
3. Set the secrets (below) with `fly secrets set --stage --app <app> KEY=value ...`.
4. Deploy in this order: scanner, migrate (build and run), api, realtime, workers, web.
5. Point DNS at fly and issue certificates: `fly certs add api.studafy.com --app studafy-core-api`,
   `fly certs add app.studafy.com --app studafy-core-web`, then add the records `fly certs show`
   prints in Vercel DNS.

## Secrets

| Secret                                                                    | api | workers             | realtime | migrate |
| ------------------------------------------------------------------------- | --- | ------------------- | -------- | ------- |
| `DATABASE_USER`, `DATABASE_PASSWORD`                                      | ✓   | ✓                   |          | ✓       |
| `DATABASE_CA_CERT` (PEM)                                                  | ✓   |                     |          | ✓       |
| `SUPABASE_CA_CERT_B64` (the same PEM, base64; written to a file)          |     | ✓                   |          |         |
| `REDIS_URL` (`rediss://…`)                                                | ✓   | ✓                   | ✓        |         |
| `S3_ENDPOINT`                                                             | ✓   | ✓                   |          |         |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (R2 token)                     | ✓   |                     |          |         |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (same R2 token)              |     | ✓                   |          |         |
| `SENTRY_DSN`                                                              | ✓   | ✓                   | ✓        |         |
| `RECORDS_ENCRYPTION_KEYS`, `RECORDS_ENCRYPTION_CURRENT_KEY_ID`            | ✓   | ✓                   |          |         |
| `AI_LLM_API_KEY` (Together)                                               | ✓   | ✓                   |          |         |
| `RESEND_API_KEY`                                                          |     | ✓                   |          |         |
| `RESEND_WEBHOOK_SECRET`                                                   | ✓   |                     |          |         |
| `WS_JWT_SECRET`                                                           |     |                     | ✓        |         |
| `TURNSTILE_SECRET_KEY`                                                    | ✓   |                     |          |         |
| `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`, `MICROSOFT_OAUTH_CLIENT_ID`/`_SECRET` | ✓   |                     |          |         |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                              | ✓   | `STRIPE_SECRET_KEY` |          |         |
| `GOOGLE_PLAY_SERVICE_ACCOUNT`, `GOOGLE_PLAY_RTDN_TOKEN`                   | ✓   |                     |          |         |
| `FIREBASE_SERVICE_ACCOUNT`                                                |     | ✓                   |          |         |

`apps/api/src/env.ts` and `apps/workers/src/env.ts` are the source of truth: a service that is
missing a required secret refuses to boot and names it.

## Deploying

```sh
fly deploy . --config infra/fly/scanner.toml --remote-only
fly deploy . --config infra/fly/migrate.toml --remote-only --build-only --push --image-label "$SHA"
fly machine run "registry.fly.io/studafy-core-migrate:$SHA" --app studafy-core-migrate \
  --region fra --rm --restart no
fly deploy . --config infra/fly/api.toml --remote-only
fly deploy . --config infra/fly/realtime.toml --remote-only
fly deploy . --config infra/fly/workers.toml --remote-only
fly deploy . --config infra/fly/web.toml --remote-only --build-arg VITE_TURNSTILE_SITE_KEY=...
```

Migrations go before the API so a release never runs against an older schema.
