# Production on fly.io

Production runs on fly.io instead of AWS ECS. Each service is its own fly app in `fra`
(Frankfurt), next to the managed services it uses:

| fly app                 | Config             | What                                                         |
| ----------------------- | ------------------ | ------------------------------------------------------------ |
| `studafy-core-api`      | `api.toml`         | apps/api, public at `api.studafy.com`                        |
| `studafy-core-realtime` | `realtime.toml`    | apps/realtime; reached through the API's `/ws` (fly-replay)  |
| `studafy-core-workers`  | `workers.toml`     | apps/workers, no inbound traffic                             |
| `studafy-core-scanner`  | `scanner.toml`     | clamd, private (Flycast) only                                |
| `studafy-core-web`      | `web.toml`         | apps/web, public at `app.studafy.com`                        |
| `studafy-core-migrate`  | `migrate.toml`     | db migrations, run as a one-off machine                      |
| `studafy-log-shipper`   | `log-shipper.toml` | ships every app's logs to Axiom (EU), dataset `studafy-logs` |

What runs when:

- **api, web**: always on (`min_machines_running = 1`). A cold start would land on a person's
  request, and the web machine is 256 MB (about $2 a month).
- **workers**: always on; they poll their queues.
- **scanner**: on demand. The workers' first connection to its Flycast address starts it, and fly's
  proxy stops it again a few minutes after the last scan. The scan worker waits up to two minutes
  for clamd to answer before it streams a file (`CLAMD_STARTUP_WAIT_MS`), so a cold start (about
  30 s) delays a scan, never fails it.
- **realtime**: scaled to zero while live updates are deferred. Nothing reaches it: the web build
  and the mobile builds leave the socket off (`VITE_REALTIME_ENABLED`, `REALTIME_ENABLED`) and the
  API has no `/ws` route while `REALTIME_FLY_APP` is unset. To turn realtime on, set
  `REALTIME_FLY_APP` (api.toml), `VITE_REALTIME_ENABLED = "true"` (web.toml), build the apps with
  `--dart-define=REALTIME_ENABLED=true`, and put realtime.toml back to `min_machines_running = 1`
  with `auto_stop_machines = "off"`.

Managed services: Postgres on Supabase (project `studafy-prod`, `eu-central-1`), Redis on Redis
Cloud (`eu-central-1`, `noeviction`, AOF every second), files on Cloudflare R2 (bucket
`studafy-prod-files`), email through Resend.

Every command below runs from the repository root.

## Database connections

The services connect through Supabase's **transaction** pooler (port 6543), which plays the part
PgBouncer played on AWS: every pool already runs `prepare: false` and nothing holds session state.
That is `aws-1-eu-central-1.pooler.supabase.com` with user `postgres.<project ref>`. Migrations
connect **directly** (`db.<project ref>.supabase.co:5432`, user `postgres`, IPv6 only, which fly
machines have). Everything is TLS verified against Supabase's root CA (`DATABASE_CA_CERT`, from
Project Settings → Database → SSL configuration; SHA-256 fingerprint `80:70:25:AD:…:E6:CA:FA`).

The services log in as the project's `postgres` user, as they did with the RDS master user. Moving
them to a dedicated `NOBYPASSRLS` login is the open follow-up in
docs/security/S-01-database-role-verification.md.

### Where Supabase differs from RDS

Supabase's `postgres` is not a superuser, which the first migrations ran into once:

- **PostgreSQL 16+ role grants.** A role created by a non-superuser is not automatically usable by
  its creator, and most migrations `SET ROLE studafy_admin`. The `postgres` role therefore carries
  `createrole_self_grant = 'set, inherit'` (`ALTER ROLE postgres SET …`, done once). The setting is
  read when a session starts, which is why migrations connect directly: a pooled server session may
  predate it.
- **Migration 000003's monitoring grants.** Supabase keeps the admin option on `pg_read_all_stats`
  and installs `pg_stat_statements` in its own `extensions` schema, so 000003's three grants for
  `studafy_monitor` cannot run. Production applied 000003 without those three statements and
  recorded it under the file's real checksum; everything else in it ran as written. The app does
  not use `studafy_monitor`.

## First-time setup

1. Create the apps (once):
   `fly apps create studafy-core-api` and the same for `-realtime`, `-workers`, `-scanner`, `-web`,
   `-migrate`. (Done 2026-11-10.)
2. Give the scanner a private address only: `fly ips allocate-v6 --private --app studafy-core-scanner`.
   (Done 2026-11-10.)
3. Put the secrets (below) in the repository's `prod` GitHub Environment, plus `FLY_API_TOKEN`: one
   `fly tokens create deploy` token per app above, joined with commas after a single `FlyV1 `
   prefix, so the deploy can touch these apps and nothing else in the organisation.
4. Run **Production deploy (fly.io)** (`.github/workflows/fly-production-deploy.yml`) from the
   Actions tab. The services come up on their `*.fly.dev` addresses.
5. Point the domains at fly (see Domains).

## Secrets

The `prod` GitHub Environment is the single source of truth. Every run of the deploy workflow copies
the secrets onto the fly apps (staged, so they apply with that deploy), so a secret is changed in
GitHub and released by rerunning the workflow — never with `fly secrets set` by hand, which the next
run would overwrite. The workflow checks the required ones up front and names any that are missing.

| GitHub secret                                                                                                                     | api | workers                          | realtime                   | migrate |
| --------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------- | -------------------------- | ------- |
| `DATABASE_USER` (`postgres.<project ref>`; migrate logs in directly as `postgres`, migrate.toml)                                  | ✓   | ✓                                |                            |         |
| `DATABASE_PASSWORD`                                                                                                               | ✓   | ✓                                |                            | ✓       |
| `DATABASE_CA_CERT` (PEM)                                                                                                          | ✓   | as `SUPABASE_CA_CERT_B64`        |                            | ✓       |
| `REDIS_URL` (`rediss://…`)                                                                                                        | ✓   | ✓                                | ✓, and as `AUTH_REDIS_URL` |         |
| `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (R2 token)                                                              | ✓   | as `AWS_ACCESS_KEY_ID`/`_SECRET` |                            |         |
| `SENTRY_DSN` (optional)                                                                                                           | ✓   | ✓                                | ✓                          |         |
| `RECORDS_ENCRYPTION_KEYS` (`{"<id>":"<base64 32 bytes>"}`), `RECORDS_ENCRYPTION_CURRENT_KEY_ID`                                   | ✓   | ✓                                |                            |         |
| `WS_JWT_SECRET` (32+ characters)                                                                                                  | ✓   |                                  | ✓                          |         |
| `AI_LLM_API_KEY` (Together)                                                                                                       | ✓   | ✓                                |                            |         |
| `RESEND_API_KEY`                                                                                                                  |     | ✓                                |                            |         |
| `RESEND_WEBHOOK_SECRET`                                                                                                           | ✓   |                                  |                            |         |
| `TURNSTILE_SECRET_KEY`                                                                                                            | ✓   |                                  |                            |         |
| `GOOGLE_PLAY_SERVICE_ACCOUNT`, `GOOGLE_PLAY_RTDN_TOKEN`                                                                           | ✓   | `GOOGLE_PLAY_SERVICE_ACCOUNT`    |                            |         |
| `FIREBASE_SERVICE_ACCOUNT`                                                                                                        |     | ✓                                |                            |         |
| Optional: `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`, `MICROSOFT_OAUTH_CLIENT_ID`/`_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | ✓   | `STRIPE_SECRET_KEY`              |                            |         |
| Optional: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` (traces to Axiom, see Observability)                        | ✓   | ✓                                | ✓                          |         |

Build-time values for the web app come from the environment's **variables**: `VITE_TURNSTILE_SITE_KEY`,
`VITE_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT` (and the `SENTRY_AUTH_TOKEN` secret, for source maps).

`apps/api/src/env.ts`, `apps/workers/src/env.ts` and `apps/realtime/src/env.ts` are the source of
truth: a service that is missing a required secret refuses to boot and names it.

## The first Studafy operator

An empty database has no account to sign in with, and every other account is created from the
product by someone already in it. `apps/api/scripts/bootstrap-platform-operator.ts` creates the
platform school (`studafy`) and a three-day SUPER_ADMIN invitation for one address, and refuses to
run once any SUPER_ADMIN exists. It uses only Bun's built-in client, so it runs inside the API
container with the API's own connection settings:

```sh
echo "put apps/api/scripts/bootstrap-platform-operator.ts /app/bootstrap.ts" | fly ssh sftp shell -a studafy-core-api
fly ssh console -a studafy-core-api -C "sh -c 'cd /app && bun bootstrap.ts --email <address> --confirm-production; rm -f bootstrap.ts'"
```

Open the printed link and sign in with Google or Microsoft as that address. Production's first
operator was created this way on 2026-11-10.

## Observability

Errors go to Sentry (`SENTRY_DSN`, project `studafy-server` in the `studafy-limited` org). Logs and
traces go to Axiom, in the organisation's EU Central edge deployment
(`https://eu-central-1.aws.edge.axiom.co`), replacing CloudWatch and Tempo from the AWS stack.

- **Logs → dataset `studafy-logs`.** The services write pino-format JSON lines to stdout; the
  `studafy-log-shipper` app (`log-shipper.toml`) reads the organisation's log stream and posts every
  line to Axiom. It sits outside the deploy workflow; its config and secrets are in that file.
- **Traces → dataset `studafy-traces`.** api, workers and realtime export OTLP/HTTP when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`packages/observability/src/tracing.ts`). The OTel exporter
  reads its auth from `OTEL_EXPORTER_OTLP_HEADERS` itself, so both are `prod` secrets:
  - `OTEL_EXPORTER_OTLP_ENDPOINT` = `https://eu-central-1.aws.edge.axiom.co`
  - `OTEL_EXPORTER_OTLP_HEADERS` = `Authorization=Bearer <xaat token, ingest on studafy-traces only>,X-Axiom-Dataset=studafy-traces`

  Leave both unset to turn tracing off. Axiom's EU edge accepts API tokens (`xaat-…`) only, not
  personal tokens.

## Domains

DNS for studafy.com is hosted by Vercel; mail is Zoho (MX/SPF records there must be left alone).
The web app serves every browser-facing domain, and the API keeps its own:

| Domain                                                                    | fly app            |
| ------------------------------------------------------------------------- | ------------------ |
| `api.studafy.com`                                                         | `studafy-core-api` |
| `studafy.com`, `www.studafy.com`, `app.studafy.com`, `school.studafy.com` | `studafy-core-web` |

For each: `fly certs add <domain> --app <app>`, then create the records `fly certs show` prints in
Vercel DNS (A/AAAA, or the `_acme-challenge` CNAME to issue the certificate before switching).
`CORS_ALLOWED_ORIGINS` (api.toml) and `WS_ALLOWED_ORIGINS` (realtime.toml) list the same browser
domains; keep the three lists in step.

## Deploying

Normally: run **Production deploy (fly.io)** from the Actions tab. By hand, the same steps:

```sh
fly deploy . --config infra/fly/scanner.toml --remote-only
fly deploy . --config infra/fly/migrate.toml --remote-only --build-only --push --image-label "$SHA"
fly machine run "registry.fly.io/studafy-core-migrate:$SHA" --app studafy-core-migrate \
  --region fra --rm --restart no --vm-memory 512 \
  --env NODE_ENV=production --env DATABASE_HOST=db.pmrzcugyvviupfjzrrye.supabase.co \
  --env DATABASE_PORT=5432 --env DATABASE_NAME=postgres --env DATABASE_USER=postgres \
  --env DATABASE_SSL_MODE=verify-full
fly logs --app studafy-core-migrate --no-tail   # "database is up to date"
fly deploy . --config infra/fly/api.toml --remote-only
fly deploy . --config infra/fly/realtime.toml --remote-only
fly deploy . --config infra/fly/workers.toml --remote-only
fly deploy . --config infra/fly/web.toml --remote-only --build-arg VITE_TURNSTILE_SITE_KEY=...
```

Migrations go before the API so a release never runs against an older schema.
