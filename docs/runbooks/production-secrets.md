# Production secrets and per-tier values

Everything a deployed tier (staging, prod; dev has its own `dev.env`) needs that is **not** in this
repository, where each value goes, and what happens when it is missing. The repository holds code and
non-secret per-tier settings only — credentials never pass through git.

How values reach a running task:

- **Secrets** go into `TF_VAR_secrets_app_secret_values` at `terraform apply` time
  (`docs/runbooks/secrets-conventions.md`). `module.secrets` writes them to
  `<name_prefix>/<service>/app-secrets` in Secrets Manager; the ECS task definitions read individual
  keys from there at task start.
- **Non-secret tier settings** (tier name, public origins) live in
  `infra/deploy/environments/<tier>.env` and are rendered into the task definitions by
  `infra/deploy/scripts/render.sh`.
- **Values baked into the web bundle** are GitHub Environment _variables_ (not secrets — they end up
  in browser JavaScript), read by `.github/workflows/release.yml` when it builds `web`.

## 1. Secrets (`TF_VAR_secrets_app_secret_values`)

Every key the api task definition reads is pre-seeded empty by `app_secret_defaults`
(`infra/terraform/main.tf`), because ECS refuses to start a task whose secret lacks a referenced key.
Empty means "not configured"; supply real values to turn each one on.

```bash
export TF_VAR_secrets_app_secret_values='{
  "api": {
    "GOOGLE_OAUTH_CLIENT_ID": "<Google Cloud: client \"Studafy production\" → Client ID>",
    "GOOGLE_OAUTH_CLIENT_SECRET": "<… → Client secret>",
    "MICROSOFT_OAUTH_CLIENT_ID": "<Entra: app \"Studafy\" → Application (client) ID>",
    "MICROSOFT_OAUTH_CLIENT_SECRET": "<… → Certificates & secrets → Value>",
    "TURNSTILE_SECRET_KEY": "<Cloudflare Turnstile widget \"studafy.com\" → Secret Key>",
    "AI_LLM_API_KEY": "<Together AI → Settings → API Keys → production key>",
    "ERPNEXT_API_KEY": "<generated, see below: api_key:api_secret>",
    "ERPNEXT_WEBHOOK_SECRET": "<generated, see below>",
    "RECONCILIATION_API_KEY": "<generated, see below>"
  },
  "workers": {
    "AI_LLM_API_KEY": "<the same Together AI production key>",
    "ERPNEXT_API_KEY": "<the same generated ERPNext key>",
    "RECONCILIATION_API_KEY": "<the same generated reconciliation key>"
  }
}'
terraform apply -var-file=environments/prod/prod.tfvars
```

| Key                                           | Service                   | If missing                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURNSTILE_SECRET_KEY`                        | api                       | **api refuses to boot** on staging/prod (`apps/api/src/env.ts`) — deliberately: without it every captcha check passes                                                                                                                                                           |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET`          | api                       | Google sign-in off (button answers 404)                                                                                                                                                                                                                                         |
| `MICROSOFT_OAUTH_CLIENT_ID` / `_SECRET`       | api                       | Microsoft sign-in off                                                                                                                                                                                                                                                           |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | api (both), workers (key) | **Optional.** Only schools outside Tap's markets (Jordan, the Gulf, Egypt) are billed through Stripe; without them those schools' checkout answers 503 `STRIPE_NOT_CONFIGURED`, and the workers refuse to run seat reconciliation once any active subscription is Stripe-billed |
| `TAP_SECRET_KEY` / `TAP_WEBHOOK_URL`          | api, workers              | Tap payments off (`docs/runbooks/tap-payments-setup.md`)                                                                                                                                                                                                                        |
| `AI_LLM_API_KEY`                              | api, workers              | **api refuses to boot** while the tier's `AI_LLM_ENABLED=true` (section 2); without the workers copy, exam generation jobs fail closed                                                                                                                                          |
| `ERPNEXT_API_KEY`                             | api, workers              | Finance (dashboard, invoices, payments, reports) answers 503 `ERPNEXT_NOT_CONFIGURED`; staging/prod only (no ERPNext plane in dev)                                                                                                                                              |
| `GOOGLE_PLAY_SERVICE_ACCOUNT` / `_RTDN_TOKEN` | api                       | Android in-app purchase of the AI add-on off (`docs/runbooks/in-app-purchase-setup.md`); set both or neither, or the **api refuses to boot**                                                                                                                                    |

`ERPNEXT_API_KEY`, `ERPNEXT_WEBHOOK_SECRET` and `RECONCILIATION_API_KEY` are not issued by any
provider: generate each once per tier and keep them with the other production keys —

```bash
echo "$(openssl rand -hex 8):$(openssl rand -hex 24)"   # ERPNEXT_API_KEY (key:secret)
openssl rand -hex 32                                    # ERPNEXT_WEBHOOK_SECRET
openssl rand -hex 32                                    # RECONCILIATION_API_KEY
```

The API sends the same credential to every school's site; `erpnext-new-site.sh` reads it from the
api app secret and sets it on each new site's integration user. The same script signs each site's
webhooks with `ERPNEXT_WEBHOOK_SECRET`, which the API verifies. `RECONCILIATION_API_KEY` is the
service key the workers' daily finance reconciliation (02:30 UTC) presents to the API — the same
value in both secrets. Rotating it means setting the new
value on every existing site too (re-run the script's setup step), so pick it once.

`GOOGLE_PLAY_RTDN_TOKEN` is not issued by Google either: `openssl rand -hex 32`, then use it in the
Pub/Sub push URL (`docs/runbooks/in-app-purchase-setup.md`). `GOOGLE_PLAY_SERVICE_ACCOUNT` is the
whole JSON key file, on one line.

Generated by Terraform, nothing to supply: `realtime`'s `WS_JWT_SECRET`, ERPNext's admin password and
encryption key. No storage credentials exist at all — the api and workers reach S3 through their ECS
task roles.

Rotation: Microsoft client secrets expire (24 months at most) — rotate before expiry, or Microsoft
sign-in stops. Google client secrets and the Turnstile secret do not expire. Rotate any of them with
`infra/deploy/scripts/rotate-app-secret.sh`.

## 2. Per-tier settings (`infra/deploy/environments/<tier>.env`)

Already filled in for every tier; listed so the provider registrations below can be checked
against them.

| Variable     | staging                           | prod                      |
| ------------ | --------------------------------- | ------------------------- |
| `APP_ENV`    | `staging`                         | `production`              |
| `WEB_ORIGIN` | `https://staging.studafy.com`     | `https://app.studafy.com` |
| `API_ORIGIN` | `https://staging-api.studafy.com` | `https://api.studafy.com` |

The api derives `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS` and both OAuth redirect URIs from these; the
workers derive their email links (`FRONTEND_URL`) from `WEB_ORIGIN`.

The same files set the AI provider for every tier: `AI_LLM_PROVIDER=openai-compatible` against
Together AI (`AI_LLM_BASE_URL=https://api.together.xyz/v1`), with `Qwen/Qwen3.5-9B` for both model
tiers and `AI_LLM_ENABLED=true`. To launch a tier with AI off instead, set `AI_LLM_ENABLED=false`
there **and** leave `AI_LLM_API_KEY` empty — the api refuses a key while AI is off. See
`docs/runbooks/anthropic-provider-config.md`.

## 3. Web bundle (GitHub → Settings → Environments → `<tier>` → Variables)

| Variable                  | prod value                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL`       | `https://api.studafy.com`                                                                                       |
| `VITE_REALTIME_BASE_URL`  | the realtime WebSocket URL, once the edge routing for apps/realtime is decided (`infra/terraform/modules/edge`) |
| `VITE_TURNSTILE_SITE_KEY` | the Turnstile widget's **Site Key** (public)                                                                    |

Unset, the bundle calls `http://localhost:3000` and renders Cloudflare's always-pass test widget —
whose tokens the api rejects once a real `TURNSTILE_SECRET_KEY` is set, so nobody could register.

## 4. Provider registrations per tier

Each provider client must list the tier's exact redirect URI (`API_ORIGIN` + path); a mismatch fails
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

Nothing to supply. The workers task runs a ClamAV sidecar (`infra/docker/clamav.Dockerfile`,
pushed by `release.yml` under the release tag) and waits for it to report healthy before starting;
`CLAMAV_HOST` is `127.0.0.1` inside the task.

## 6. Each school's ERPNext site (staging/prod)

Finance for a school only works once its ERPNext site exists. Signing up writes the school's site as
`pending` in `app.erpnext_site_configs`; after the first deploy (and for every school that signs up
later) an operator creates it:

```bash
infra/deploy/scripts/erpnext-new-site.sh prod <site_name> --school-id <school_id> \n  --company "<company_name>" --abbr <ABBR>
```

with the values from that school's `app.erpnext_site_configs` row. The site switches itself on at
the school's next finance request. Full steps and troubleshooting:
`docs/runbooks/tenant-provisioning-checklist.md`.
