# Production secrets and settings

Everything production needs that is **not** in this repository, where each value goes, and what
happens when it is missing. The repository holds code and non-secret settings only — credentials
never pass through git. There is one deployed tier, `prod`, on fly.io; there is no staging.

How values reach a running machine:

- **Secrets** live in the repository's `prod` GitHub Environment, the single source of truth. Every
  run of **Production deploy (fly.io)** (`.github/workflows/fly-production-deploy.yml`) copies them
  onto the fly apps (staged, so they apply with that deploy) and first fails, naming them, if any
  required one is missing. Change a secret in GitHub and rerun the workflow; never `fly secrets set`
  by hand, which the next run would overwrite. Which app gets which secret:
  [`infra/fly/README.md#secrets`](../../infra/fly/README.md#secrets).
- **Non-secret settings** (tier name, public origins, database hosts, AI provider) are the `[env]`
  tables of `infra/fly/<app>.toml`.
- **Values baked into the web bundle** are GitHub Environment _variables_ (not secrets — they end up
  in browser JavaScript), passed as build arguments when the workflow deploys `web`.

`apps/api/src/env.ts`, `apps/workers/src/env.ts` and `apps/realtime/src/env.ts` are the source of
truth: a service missing a required value refuses to boot and names it.

## 1. Secrets (`prod` GitHub Environment)

| Key                                                     | Service                       | If missing                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_USER` / `_PASSWORD` / `_CA_CERT`              | api, workers, migrate         | **api refuses to boot** in production. Supabase's pooler login (`postgres.<project ref>`), its password, and Supabase's root CA (PEM); see `infra/fly/README.md#database-connections`                                                                                                                                                                          |
| `REDIS_URL`                                             | api, workers, realtime        | The deploy workflow refuses to run. Redis Cloud's `rediss://` URL                                                                                                                                                                                                                                                                                              |
| `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | api, workers                  | The deploy workflow refuses to run. A Cloudflare R2 API token for `studafy-prod-files`; the access keys must be set together                                                                                                                                                                                                                                   |
| `TURNSTILE_SECRET_KEY`                                  | api                           | **api refuses to boot** outside development (`apps/api/src/env.ts`) — deliberately: without it every captcha check passes                                                                                                                                                                                                                                      |
| `WS_JWT_SECRET`                                         | api, realtime                 | **api refuses to boot** with the development default or anything under 32 characters. The api signs realtime handshake tickets with it (QA-14)                                                                                                                                                                                                                 |
| `RECORDS_ENCRYPTION_KEYS` / `_CURRENT_KEY_ID`           | api, workers                  | **api and workers refuse to boot** outside development, and refuse the in-repository development key (ADR-019). Seals sensitive student/parent record values. Back it up with the other keys: **losing it loses every sensitive value**. To rotate, add a key id, point `_CURRENT_KEY_ID` at it, let the daily maintenance job re-seal, then remove the old id |
| `AI_LLM_API_KEY`                                        | api, workers                  | **api refuses to boot** while `AI_LLM_ENABLED=true` (`infra/fly/api.toml`); without the workers copy, exam generation jobs fail closed                                                                                                                                                                                                                         |
| `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`              | workers / api                 | The deploy workflow refuses to run. Resend sends every email; the api verifies Resend's delivery events at `/email/webhooks/resend` with the webhook secret                                                                                                                                                                                                    |
| `FIREBASE_SERVICE_ACCOUNT`                              | workers                       | The deploy workflow refuses to run. Push notifications (`docs/runbooks/fcm-setup.md`)                                                                                                                                                                                                                                                                          |
| `GOOGLE_PLAY_SERVICE_ACCOUNT` / `_RTDN_TOKEN`           | api (both), workers (account) | The deploy workflow refuses to run. Android in-app purchase of the AI add-on (`docs/runbooks/in-app-purchase-setup.md`); set both or neither, or the **api refuses to boot**                                                                                                                                                                                   |
| `SENTRY_DSN`                                            | api, workers, realtime        | Optional. Server errors are not reported to Sentry                                                                                                                                                                                                                                                                                                             |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET`                    | api                           | Optional. Google sign-in off (button answers 404)                                                                                                                                                                                                                                                                                                              |
| `MICROSOFT_OAUTH_CLIENT_ID` / `_SECRET`                 | api                           | Optional. Microsoft sign-in off                                                                                                                                                                                                                                                                                                                                |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`           | api (both), workers (key)     | Optional. Every school bills through Stripe while `TAP_COUNTRIES` is empty (the default: Studafy's company is Irish, and Tap only takes merchants registered in its markets). Without them, buying the AI add-on on the website answers 503 `STRIPE_NOT_CONFIGURED`                                                                                            |

Not wired into the deploy workflow today, so they stay unset on fly (and their features stay off)
until the workflow's secret list gains them: `TAP_SECRET_KEY` / `TAP_WEBHOOK_URL` (Tap payments,
`docs/runbooks/tap-payments-setup.md`), and `ERPNEXT_API_URL` / `ERPNEXT_API_KEY` /
`ERPNEXT_WEBHOOK_SECRET` / `RECONCILIATION_API_KEY` (finance answers 503 `ERPNEXT_NOT_CONFIGURED`;
there is no ERPNext deployment on fly). Adding one means a `prod` secret plus a line in the
workflow's `stage` calls — see `infra/README.md`'s "Where to change X".

`GOOGLE_PLAY_RTDN_TOKEN` is not issued by Google: `openssl rand -hex 32`, then use it in the Pub/Sub
push URL (`docs/runbooks/in-app-purchase-setup.md`). `GOOGLE_PLAY_SERVICE_ACCOUNT` is the whole JSON
key file, on one line. The workers get the same key: the account-deletion sweep uses it to turn off
a deleted student's Google Play renewal, and without it logs and skips that call
(`docs/modules/account-deletion.md`).

Rotation: Microsoft client secrets expire (24 months at most) — rotate before expiry, or Microsoft
sign-in stops. Google client secrets and the Turnstile secret do not expire. Rotate any of them by
changing the `prod` secret and rerunning the deploy workflow.

## 2. Non-secret settings (`infra/fly/<app>.toml` `[env]`)

Already filled in; listed so the provider registrations below can be checked against them.

| Variable                       | prod                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `APP_ENV`                      | `production`                                                                                     |
| `FRONTEND_URL`                 | `https://app.studafy.com` (api, workers — email links)                                           |
| `CORS_ALLOWED_ORIGINS`         | `https://studafy.com,https://www.studafy.com,https://app.studafy.com,https://school.studafy.com` |
| `GOOGLE_OAUTH_REDIRECT_URI`    | `https://api.studafy.com/api/auth/oauth/google/callback`                                         |
| `MICROSOFT_OAUTH_REDIRECT_URI` | `https://api.studafy.com/api/auth/oauth/microsoft/callback`                                      |

The same files set the AI provider: `AI_LLM_PROVIDER=openai-compatible` against Together AI
(`AI_LLM_BASE_URL=https://api.together.xyz/v1`), with `Qwen/Qwen3.5-9B` for both model tiers and
`AI_LLM_ENABLED=true` on the api. To run with AI off instead, set `AI_LLM_ENABLED=false` there
**and** remove `AI_LLM_API_KEY` — the api refuses a key while AI is off. See
`docs/runbooks/anthropic-provider-config.md`.

## 3. Web bundle (GitHub → Settings → Environments → `prod` → Variables)

| Variable                  | prod value                                                                        |
| ------------------------- | --------------------------------------------------------------------------------- |
| `VITE_TURNSTILE_SITE_KEY` | the Turnstile widget's **Site Key** (public)                                      |
| `VITE_SENTRY_DSN`         | Sentry project `studafy-web` → Client Keys (DSN); public, it can only send events |
| `SENTRY_ORG`              | `studafy-limited`                                                                 |
| `SENTRY_PROJECT`          | `studafy-web`                                                                     |

`VITE_API_BASE_URL` (`https://api.studafy.com`) and the realtime URL are build arguments in
`infra/fly/web.toml`, not variables.

One Environment **secret** belongs with them: `SENTRY_AUTH_TOKEN`, a Sentry organization token
(Settings → Developer Settings → Organization Tokens) that lets the web build upload source maps, so
the website's errors show readable stack traces. Without it errors are still reported, with minified
stacks.

An unset `VITE_TURNSTILE_SITE_KEY` renders Cloudflare's always-pass test widget — whose tokens the
api rejects once a real `TURNSTILE_SECRET_KEY` is set, so nobody could register.

## 4. Provider registrations

Each provider client must list production's exact redirect URI (`GOOGLE_OAUTH_REDIRECT_URI` / `MICROSOFT_OAUTH_REDIRECT_URI` in `infra/fly/api.toml`); a mismatch fails
sign-in with `redirect_uri_mismatch` / `AADSTS50011`.

| Provider  | prod redirect URI                                           | Where                                                      |
| --------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| Google    | `https://api.studafy.com/api/auth/oauth/google/callback`    | Google Auth Platform → Clients → Studafy production        |
| Microsoft | `https://api.studafy.com/api/auth/oauth/microsoft/callback` | Entra → App registrations → Studafy → Authentication (Web) |
| Turnstile | hostname `studafy.com`                                      | Cloudflare → Turnstile → widget settings                   |

Native-app sign-in needs no extra registration: the app goes through the api's own callback and is
handed a one-time code (`apps/api/src/modules/auth/oauth/mobile-handoff.ts`).

Before opening sign-in to everyone: publish the Google app (Audience → Publish) and complete Microsoft
publisher verification (Partner ID on the `Studafy` app's Branding & properties) — without the latter,
school tenants that block unverified multitenant apps cannot sign in.

## 5. Malware scanning

Nothing to supply. The workers reach ClamAV on the `studafy-core-scanner` fly app over its private
Flycast address (`CLAMAV_HOST = "studafy-core-scanner.flycast"` in `infra/fly/workers.toml`); the
deploy workflow deploys the scanner first. See `infra/fly/README.md`.
