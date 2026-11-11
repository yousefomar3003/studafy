# Secrets inventory and rotation runbook

Where production's secrets live, how they reach the running services, and the conventions for
setting one. Production runs on fly.io ([`infra/fly/README.md`](../../infra/fly/README.md)); the
per-key list of what each secret does and what happens when it is missing is
[`production-secrets.md`](production-secrets.md).

**Operational rotation procedures live in `security/`** — one runbook per secret class plus the
quarterly schedule and drill ([`security/README.md`](security/README.md),
[`security/rotation-schedule.md`](security/rotation-schedule.md)). This file is the inventory and
the wiring conventions; it deliberately does not duplicate the procedures.

## Secrets inventory

There is one store: the repository's **`prod` GitHub Environment** (Settings → Environments →
`prod` → Secrets). [`infra/fly/README.md#secrets`](../../infra/fly/README.md#secrets) has the table
of every secret and which fly app receives it; `.github/workflows/fly-production-deploy.yml` is the
code that does the copying, and its `stage` calls are the authoritative per-app list.

Secrets held outside GitHub, because they belong to a fly app the deploy workflow does not manage:

| Secret                       | Where                                | What                                                                       |
| ---------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `HTTP_TOKEN`, `ACCESS_TOKEN` | fly secrets on `studafy-log-shipper` | Axiom ingest token; fly read-only org token (`infra/fly/log-shipper.toml`) |

The provider-side credentials themselves (Supabase's `postgres` password, the Redis Cloud URL, the
R2 API token, the Resend key, ...) are issued in each provider's dashboard; GitHub holds the copy the
services use.

**No secret's value is ever committed.** Non-secret settings are the `[env]` tables of
`infra/fly/<app>.toml`; a value that is a credential never goes there.

## Application secrets: how to set one

1. Change (or add) the secret in the `prod` GitHub Environment.
2. If it is new, add it to the deploy workflow's `env:` block and to the `stage` call of every app
   that needs it (and to the up-front `missing` check if the service refuses to boot without it).
   Add it to the app's `src/env.ts` as well.
3. Rerun **Production deploy (fly.io)**. Every run copies the secrets onto the fly apps, staged, so
   they apply with that deploy.

Never use `fly secrets set` by hand for a secret the workflow manages: the next run overwrites it.

`WS_JWT_SECRET` signs (`apps/api`) and verifies (`apps/realtime`) realtime handshake tickets. Both
default it to `"dev-insecure-secret-change-me"` for local work and refuse to start with that value,
or one under 32 characters, in production (QA-14). The workflow stages the same GitHub secret onto
both apps, so set or rotate it in one place.

## Postgres credential rotation

The services log in to Supabase as the project's `postgres` user (`infra/fly/README.md#database-connections`).
Nothing rotates that password automatically. The procedure is
[`security/rotation-db.md`](security/rotation-db.md), under the quarterly schedule in
[`security/rotation-schedule.md`](security/rotation-schedule.md).

## Known gaps

- **No automatic rotation for any secret.** Every rotation is manual: change the value at the
  provider, update the `prod` secret, rerun the deploy workflow.
- **One shared database login.** api, workers and migrations all use Supabase's `postgres` user, so
  rotating its password touches every service at once, and there is no per-service role to rotate
  independently. Moving the services to a dedicated `NOBYPASSRLS` login is the open follow-up in
  `docs/security/S-01-database-role-verification.md`.
- **No rotation procedure for the Redis Cloud credential** (`REDIS_URL`, shared by api, workers and
  realtime) has been written yet.
- **A changed secret only applies on the next deploy.** The workflow stages secrets rather than
  restarting machines on its own, so a rotation and a release are the same event.
