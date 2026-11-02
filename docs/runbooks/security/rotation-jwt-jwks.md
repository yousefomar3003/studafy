# Secret rotation: JWT signing keys (JWKS overlap)

The RSA signing/verification key pairs that sign `apps/api`'s access tokens. This is a distinct
class from the other three: the key material never leaves process memory, never enters Secrets
Manager, and rotation is already automatic. A quarterly drill verifies the overlap property that
makes rotation zero-downtime.

Source: `apps/api/src/modules/auth/jwt/key-store.ts` (`KeyStore`), wired in
`apps/api/src/index.ts:138-141`, served at `GET /.well-known/jwks.json`
(`apps/api/src/modules/auth/jwks/route.ts`). Verification architecture:
[`docs/security/JWT_verification_architecture.md`](../../security/JWT_verification_architecture.md).

Boundary: `apps/realtime`'s `WS_JWT_SECRET` (HMAC `HS256`, `apps/realtime/src/auth.ts`) is a
**different class** — an application secret held in Secrets Manager, not a JWT signing key pair.
Rotate it through the application-secret procedure
([`rotation-provider-api-keys.md`](rotation-provider-api-keys.md)).

## What already rotates itself

`KeyStore` holds at most two key pairs, `current` (signing + verification) and `previous`
(verification only). Every `JWT_KEY_ROTATION_INTERVAL_MS` (default 7 days) it generates a fresh
RSA-2048 pair, demotes `current` to `previous`, and drops the old `previous`. The JWKS endpoint
serves both, keyed by `kid`, so tokens signed by the outgoing key stay verifiable until they expire
— that is the JWKS-overlap property, and it is the entire zero-downtime mechanism. Each rotation is
logged: `logger.info({ kid }, "jwt key rotated")`, the structured-log audit trail for this class.

No operator action rotates keys. What needs a human, quarterly, is _proving the overlap holds_ and
noticing if it ever stops holding.

## Quarterly drill (staging)

**1. Prove the JWKS advertises the last two keys.**

```bash
curl -fsS https://<edge_domain>/.well-known/jwks.json | jq '.keys[] | {kid, alg, use, kty}'
```

Expect exactly two keys unless the process started < the rotation interval ago (then one). Both
`alg=RS256`, `use=sig`, `kty=RSA`, distinct `kid`s.

**2. Rotate on demand and watch the overlap live.**

A restart regenerates both keys (see the gap below), so the clean way to force a live rotation in
staging is the same mechanism a deploy uses:

```bash
aws ecs update-service --cluster <cluster> --service <name_prefix>-api --force-new-deployment
aws ecs wait services-stable --cluster <cluster> --services <name_prefix>-api
```

Then immediately re-fetch the JWKS and note that both keys' kids changed. A token signed under the
pre-restart `kid` is _not_ verifiable after the restart (see the gap) — the overlap guarantee is
within a process lifetime, which is what the 7-day timer preserves.

**3. Verify a token signs and verifies end-to-end.** Sign with the live `current` key and verify
against the served JWKS with `jose`'s `createLocalJWKSet` — the same assertion
`apps/api/src/modules/auth/jwt/sign-verify.test.ts:229` makes under test, run against the real
endpoint.

**4. Audit trail (required recording, not optional):** capture the `jwt key rotated` log lines from
the service's log group for the rotation window. See
[`rotation-schedule.md`](rotation-schedule.md)'s audit/evidence section for the exact query.

## Honest gaps

- **Key material is in-memory and ephemeral.** No PEM is persisted (`KeyStore.init()` takes an
  optional `privateKeyPem`; `index.ts` passes none), so a container restart discards `previous`
  along with `current`. Any access token minted before the restart becomes unverifiable for its
  remaining TTL on the next restart/rotate. This is bounded (access TTL default 900s,
  `JWT_ACCESS_TTL_SECONDS`) and automatic (`KeyStore` rotates on init), but it is not the
  persistent-key scheme some clients assume JWKS implies. If a zero-gap restart guarantee ever
  becomes an acceptance criterion, the change is: persist key pairs in Secrets Manager and load via
  the optional `init(privateKeyPem)` path. Not done here.
- **`onRotate` is wired to the logger only** (`index.ts:139`), so a failed/absent log shipment is a
  silent gap in the audit trail. No separate durable event store holds rotation events (the
  `app.security_events` table structurally cannot: it is for unauthenticated _request_ rejections —
  `db/migrations/000028`; `app.audit_logs` requires a tenant and actor). The structured log and
  CloudWatch retention are the record.

## Known gaps

- Realtime tokens are HMAC-HS256 with `WS_JWT_SECRET`; rotating that secret invalidates _all_
  live WebSocket sessions at once (tasks re-read it at launch). That class's runbook
  ([`rotation-provider-api-keys.md`](rotation-provider-api-keys.md)) treats it as downtime-forcing
  by design, not silently.
