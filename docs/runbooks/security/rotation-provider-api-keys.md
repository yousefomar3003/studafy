# Secret rotation: provider API keys

The app-level credentials that authenticate calls out to third-party providers: the LLM provider
(`AI_LLM_API_KEY`, Together AI in production), Stripe (secret key), Google/Microsoft OAuth client
secrets, ERPNext (`ERPNEXT_API_KEY`), and the Cloudflare R2 access keys (`S3_ACCESS_KEY_ID` /
`S3_SECRET_ACCESS_KEY`). They live in the `prod` GitHub Environment, the single source of truth —
see [`secrets-conventions.md`](../secrets-conventions.md).

Boundary: webhook-verification secrets (Stripe webhook, Resend webhook, ERPNext webhook HMAC) have
their own runbook because they must be updated on the _sending_ side too —
[`rotation-webhook-secrets.md`](rotation-webhook-secrets.md).

## Before the first rotation: is the key wired?

A secret only reaches fly if `.github/workflows/fly-production-deploy.yml` lists it, in its `env:`
block and in the `stage` call of each app that uses it. A key that is not listed there (today:
`ERPNEXT_API_KEY`, `TAP_SECRET_KEY`, `ANTHROPIC_API_KEY`) rotates the GitHub value with no runtime
effect. Wiring one is a workflow change, made once; after that the procedure below is sufficient.

## The shared rotation step

Every provider-key rotation ends the same way: set the new value in the `prod` GitHub Environment
(Settings → Environments → `prod` → Secrets) and run **Production deploy (fly.io)**. The workflow
stages the secret onto every app that uses it and redeploys them. Never `fly secrets set` a managed
secret by hand — the next run overwrites it. The _acquiring_ half (asking the provider to issue a
new key) is always manual, per provider below.

## Per-provider procedure

Every provider rotation is the same shape — **acquire → store → roll → verify → revoke old** —
with grace windows that differ per provider.

### LLM provider (`AI_LLM_API_KEY`, api and workers)

1. Generate a new key in the provider's console (Together AI → Settings → API Keys; order: new key
   first, so the old one can be revoked only after production is verified against the new).
2. Set `AI_LLM_API_KEY` in the `prod` environment and run the deploy workflow (it goes to both api
   and workers).
3. Verify: an AI generate call answers 200 (not `AUTH_INVALID_KEY`), e.g. the
   `ai-provider-outage.md` probe with the new key; `curl -sf https://api.studafy.com/healthz` stayed
   200 through the deploy.
4. After > 24h with no `401` spikes, revoke the old key in the console.

### Stripe secret key

1. Create a new restricted/secret key in the Stripe dashboard — keep the old one until step 4.
2. Set `STRIPE_SECRET_KEY` and run the deploy workflow (api and workers). The api validates it
   and `STRIPE_WEBHOOK_SECRET` as a pair (`apps/api/src/env.ts`), so both must stay set.
3. Verify: a live checkout/webhook path answers with the expected status (not
   `AuthenticationError`); confirm no new Stripe errors in Sentry.
4. After the next customer cycle completes, delete the old key in the dashboard.

### Google / Microsoft OAuth client secrets

Google and Microsoft do not rename the OAuth client when you rotate its secret — they re-issue
`client_secret`. The public `client_id` is not secret; the `client_secret` is.

1. Re-issue each client secret in the provider console (new value, same client).
2. Set `GOOGLE_OAUTH_CLIENT_SECRET` (and the Microsoft pair) and run the deploy workflow. The
   `env.ts` schema requires the client id + secret + redirect URI to move as a triplet, so keep the
   other two unchanged.
3. Verify: one real OAuth sign-in against `https://app.studafy.com` completes (activation worked, not a
   `Invalid client` error).
4. After a week without a sign-in regression, discard the old secret in the console (provider
   panels do not always show an explicit revoke — confirming the new one is _active_ is the test).

### ERPNext API key

1. Create a new API key in the ERPNext/bench instance (`frappe.auth.get_key` or the user's API
   access page). Note ERPNext enforces `erpnext_api_key` / `erpnext_api_secret` pairs.
2. Set `ERPNEXT_API_KEY` (and the paired secret if the integration uses one) and run the deploy
   workflow — once the key is wired into it (see the top of this runbook; there is no ERPNext
   deployment on fly today).
3. Verify: an ERPNext-backed call answers 200; the webhook path still verifies (see
   [`rotation-webhook-secrets.md`](rotation-webhook-secrets.md) — the webhook secret moves
   independently; both endpoints drift apart if only one half is rotated).
4. Revoke the old key in ERPNext after confirmed good calls.

### S3-compatible access keys (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`)

The Cloudflare R2 API token for `studafy-prod-files`. The api reads it as
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`; the workflow hands the workers the same pair as
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.

1. Create a new R2 API token in the Cloudflare dashboard.
2. Set both halves in the `prod` environment and run the deploy workflow (they must be set together
   to satisfy the schema's pair rule).
3. Verify: a put/get of an attachment round-trips (or, for a read-only reporter, a list succeeds).
4. After the configured rotation window, delete the old pair in the console.

## Rollback / abort criteria

- Abort if another run of the deploy workflow is in flight (the workflow's concurrency group queues
  runs rather than cancelling them, but the second would release whatever ref it was dispatched on).
- If the app fails against the new key _before the old key is revoked_, revoking nothing and
  rerunning the workflow with the old key value restored is the rollback — that is why "revoke old" is always
  the last step, never executed reflexively on a bad deploy.
