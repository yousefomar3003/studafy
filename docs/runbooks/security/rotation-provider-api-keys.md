# Secret rotation: provider API keys

The app-level credentials in each service's Secrets Manager container
(`<name_prefix>/<service>/app-secrets`) that authenticate calls out to third-party providers:
Anthropic (`ANTHROPIC_API_KEY`), Stripe (secret key), Google/Microsoft OAuth client secrets,
ERPNext (`ERPNEXT_API_KEY`), and S3-compatible storage access keys. These are supplied to the API
via `TF_VAR_secrets_app_secret_values` at apply time (Terraform is the source of truth — see
[`secrets-conventions.md`](../secrets-conventions.md)).

Boundary: webhook-verification secrets (Stripe webhook, ERPNext webhook HMAC) have their own
runbook because they must be updated on the _sending_ side too —
[`rotation-webhook-secrets.md`](rotation-webhook-secrets.md).

## Before the first rotation: wire the key into the runtime (one-time, per key)

Today the `api` task definition reads only `DATABASE_*`, `REDIS_URL`, and S3 from Secrets Manager
(`infra/deploy/ecs/api/task-definition.json.tpl`). A provider key that is _not yet referenced_
there rotates the secret value with no runtime effect. Wiring one key means adding a `secrets`
entry and redeploying the service:

```json
// infra/deploy/ecs/api/task-definition.json.tpl, inside the container's "secrets" array:
{ "name": "ANTHROPIC_API_KEY", "valueFrom": "${API_APP_SECRETS_ARN}:ANTHROPIC_API_KEY::" }
```

Then register the new revision and roll it (`deploy.sh api <env> <image-tag>`, or a plain
`aws ecs update-service --force-new-deployment` — ECS resolves `valueFrom` at task launch, so the
running container picks the key up on the next task start). After wiring, the rotation script below
is sufficient; it does not need the template touched again.

## The shared rotation primitive: `rotate-app-secret.sh`

`infra/deploy/scripts/rotate-app-secret.sh` implements the mechanical half of every provider-key
rotation — and only that half: read current service secret, merge the new key's value, apply it
through Terraform (so state and Secrets Manager agree), force a rolling service update
(`--force-new-deployment`, `minimumHealthyPercent 100` = the zero-downtime path), and wait for the
service to stabilize. The _acquiring_ half (asking the provider to issue a new key) is always
manual, per provider below.

```bash
# Generate a fresh value (for a symmetric secret with no provider-side lifecycle):
infra/deploy/scripts/rotate-app-secret.sh staging api ANTHROPIC_API_KEY --generate

# Or rotate to a value the operator has already obtained from the provider's console:
infra/deploy/scripts/rotate-app-secret.sh staging api STRIPE_SECRET_KEY 'sk_live_...'
```

Run it from the repository root with the same `TF_VAR_bastion_allowed_ssh_cidrs` /
`TF_VAR_bastion_key_name` exports any apply of that environment needs (see
`infra/terraform/README.md`).

## Per-provider procedure

Every provider rotation is the same shape — **acquire → store → roll → verify → revoke old** —
with grace windows that differ per provider.

### Anthropic (`ANTHROPIC_API_KEY`, api)

1. Generate a new key in the Anthropic console (order: new key first, so the old one can be revoked
   only after staging is verified against the new).
2. `/api/...rotate-app-secret.sh staging api ANTHROPIC_API_KEY <new-key>`.
3. Verify: from the deploy, an AI generate call answers 200 (not `AUTH_INVALID_KEY`), e.g. the
   `ai-provider-outage.md` probe with the new key; `curl -sf https://<edge_domain>/healthz` stayed
   200 through the roll.
4. After > 24h (or one failed-rotation cycle) with no `401` spikes, revoke the old key in the
   console. Anthropic fine-grained keys: revoke, then delete.

### Stripe secret key

1. Create a new restricted/secret key in the Stripe dashboard — keep the old one until step 4.
2. `rotate-app-secret.sh staging api STRIPE_SECRET_KEY <sk_...>`. Stripe also requires keeping
   `STRIPE_WEBHOOK_SECRET` in lockstep within the same apply — in this repo the two are supplied
   and validated as a pair (`apps/api/src/env.ts`), so rotate both in one run.
3. Verify: a live checkout/webhook path against staging answers with the expected status (not
   `AuthenticationError`); confirm no `401` jumps in the API metrics.
4. After the next customer cycle completes, delete the old key in the dashboard.

### Google / Microsoft OAuth client secrets

Google and Microsoft do not rename the OAuth client when you rotate its secret — they re-issue
`client_secret`. The public `client_id` is not secret; the `client_secret` is.

1. Re-issue each client secret in the provider console (new value, same client).
2. `rotate-app-secret.sh staging api GOOGLE_OAUTH_CLIENT_SECRET <secret>` (and the Microsoft pair).
   The `env.ts` schema requires the client id + secret + redirect URI to move as a triplet, so keep
   the other two unchanged in the same apply.
3. Verify: one real OAuth sign-in against the staging origin completes (activation worked, not a
   `Invalid client` error).
4. After a week without a sign-in regression, discard the old secret in the console (provider
   panels do not always show an explicit revoke — confirming the new one is _active_ is the test).

### ERPNext API key

1. Create a new API key in the ERPNext/bench instance (`frappe.auth.get_key` or the user's API
   access page). Note ERPNext enforces `erpnext_api_key` / `erpnext_api_secret` pairs.
2. `rotate-app-secret.sh staging api ERPNEXT_API_KEY <new-key>` (and the paired secret if the
   integration uses one).
3. Verify: an ERPNext-backed call from staging answers 200; the webhook path still verifies (see
   [`rotation-webhook-secrets.md`](rotation-webhook-secrets.md) — the webhook secret moves
   independently; both endpoints drift apart if only one half is rotated).
4. Revoke the old key in ERPNext after confirmed good calls.

### S3-compatible access keys (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`)

Used for non-AWS storage (MinIO etc.) in `apps/api`; AWS-native deployments use a task role and no
keys at all (`apps/api/src/env.ts`'s storage block).

1. Create a new access-key pair in the provider's IAM/keys console.
2. `rotate-app-secret.sh staging api S3_ACCESS_KEY_ID <new-id>` and then the secret half in the
   same apply window (they must be set together to satisfy the schema's pair rule).
3. Verify: a put/get of an attachment round-trips (or, for a read-only reporter, a list succeeds).
4. After the configured rotation window, delete the old pair in the console.

## Rollback / abort criteria

- Abort before `rotate-app-secret.sh` if the target service is mid-deploy (a concurrent
  `staging-deploy` run would fight the same ECS service). The rolling update itself self-heals:
  with the circuit breaker enabled, a service that never stabilizes rolls back automatically
  (`infra/deploy/ecs/*/service.json.tpl`).
- If the app fails against the new key _before the old key is revoked_, revoking nothing and
  re-running the script with the old key value is the rollback — that is why "revoke old" is always
  the last step, never executed reflexively on a bad deploy.
