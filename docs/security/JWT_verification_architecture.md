# JWT verification and key management

How a request proves who it is, how that proof is checked, and how a session is ended early. Covers
ST-070: the verification middleware, the asymmetric signing service, JWKS rotation, and the Redis
`jti` denylist.

The short version: access tokens are stateless and RS256-signed, verified locally against an
in-memory key set with no network call, and the only stateful check on the path is a single Redis
`EXISTS` against a revocation list. Measured overhead is ~0.3 ms p95 against a 2 ms budget.

## The token

Minted by [`signAccessToken`](../../apps/api/src/modules/auth/jwt/sign.ts), verified by
[`verifyAccessToken`](../../apps/api/src/modules/auth/jwt/verify.ts).

Header: `{ "alg": "RS256", "kid": "<uuid>" }`.

| Claim               | Type              | Source of truth              | Notes                                                                                                  |
| ------------------- | ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `sub`               | uuid              | `app.users.id`               | The user. Becomes `auth.userId`.                                                                       |
| `school_id`         | uuid              | `app.users.school_id`        | The tenant. Becomes `auth.schoolId`. Drives RLS — see below.                                           |
| `roles`             | `app.user_role[]` | `app.user_roles.role`        | Non-empty. Validated against `ROLES` in [`@studafy/constants`](../../packages/constants/src/roles.ts). |
| `entitlements_ver`  | int               | —                            | Bumped when roles change, so caches can invalidate without revoking.                                   |
| `channel`           | enum              | —                            | `web` \| `mobile` \| `api`. See [`channels.ts`](../../apps/api/src/modules/auth/channels.ts).          |
| `jti`               | uuid              | generated per call           | The revocation handle.                                                                                 |
| `iss`, `aud`        | string            | `JWT_ISSUER`, `JWT_AUDIENCE` | Defaults `studafy` / `studafy-api`.                                                                    |
| `iat`, `nbf`, `exp` | int               | —                            | Lifetime from `JWT_ACCESS_TTL_SECONDS`, default 900s.                                                  |

`channel` is the one claim with no database counterpart. There is no `channel` column anywhere in
`db/migrations`, because it describes how a session was established rather than anything about the
user — it exists so policy can distinguish a mobile session from a server-to-server one without a
lookup. If that distinction never earns its keep, the claim should be dropped rather than left as
decoration.

### Why `sub` and `school_id` are checked as UUIDs, but loosely

They are validated against a plain 8-4-4-4-12 hex pattern, **not** `z.uuid()` — which is what
`uuidSchema` in `@studafy/shared-schemas` is, and which additionally enforces the RFC 9562 version
and variant nibbles.

That stricter check would be wrong here. `app.users.id` is a Postgres `uuid` column;
`gen_random_uuid()` is only its _default_, and the column will hold an id that arrived from a data
import or a legacy system just as happily. Enforcing v4 bits in the token would 401 a user whose row
is perfectly valid everywhere else in the system. The property actually worth guaranteeing is
narrower and still holds: the value is a fixed-length hex string, so it cannot smuggle anything into
the `app.school_id` GUC or a query.

### Why an unknown role fails the whole token

`roles` is parsed against the `ROLES` const object, whose values are byte-identical to the
`app.user_role` enum by design (ADR-0002). An unrecognised value rejects the token rather than being
filtered out.

Filtering would be the more forgiving choice and the wrong one: a role rename shipped in a migration
would silently downgrade every affected user's access, and the symptom — "some users mysteriously
lost permissions" — is far harder to trace than a 401 on the first request after deploy.

## Verification path

[`jwtAuthMiddleware`](../../apps/api/src/middleware/jwtAuth.ts), mounted on `/api/*`.

```
1. Public-path check          string comparison
2. Authorization header       parse only — no crypto, no I/O
3. verifyAccessToken          kid → key, one RSA verify, exp/iss/aud, claim schema
4. denylist.isRevoked(jti)    one Redis EXISTS
5. c.set("auth", …)           + re-child the request logger
```

The order is the performance design, not incidental. Each step is more expensive than the last, and
every rejection returns before the next one runs — so a forged or expired token is rejected without
a single Redis round-trip. Under a flood of garbage credentials that difference is the whole
behaviour: inverting steps 3 and 4 would put a network hop in front of every attack request.

Ordering is invisible to a status code — a middleware that checked Redis first would return the same
401 — so [`short-circuit.test.ts`](../../apps/api/tests/auth/short-circuit.test.ts) holds it by
counting denylist lookups instead.

### Key resolution and algorithm pinning

`alg` is checked against `RS256` twice: once on the decoded header before key resolution, and again
via `jwtVerify`'s `algorithms` option. The second is the check that matters; the first means a token
claiming `none` or an HMAC algorithm never reaches key resolution at all. Without pinning, algorithm
confusion is blocked only incidentally by key type, which is not a property worth relying on.

Key lookup goes through the token's own `kid` into a map, so verification performs exactly one
signature check regardless of how many keys are live — rather than handing jose the whole key set
and letting it work out which one applies.

## Key rotation

[`KeyStore`](../../apps/api/src/modules/auth/jwt/key-store.ts) holds at most two RSA-2048 pairs:
`current` (signs and verifies) and `previous` (verifies only). `rotate()` promotes current to
previous and generates a new current, on a timer set by `JWT_KEY_ROTATION_INTERVAL_MS` (default 7
days).

Both keys appear in the JWKS, and that two-key overlap is the point: a token minted seconds before a
rotation stays verifiable until it expires. Without it, every rotation would log the entire userbase
out. A key that has rotated fully out — two rotations — no longer resolves, and its tokens are
rejected as unknown-`kid`.

`GET /.well-known/jwks.json` ([route](../../apps/api/src/modules/auth/jwks/route.ts)) publishes the
public keys, unauthenticated, with `Cache-Control: public, max-age=300`. Requiring a token to fetch
the keys needed to verify tokens would be circular.

The exported key set is memoized and invalidated on rotation. Measured on Bun 1.3 this saves ~6 µs
per request against ~7 µs uncached — real, but not the reason the latency budget is met. Essentially
all of the ~0.3 ms is the RSA verification itself.

## Revocation

[`denylist.ts`](../../apps/api/src/modules/auth/denylist.ts). Stateless tokens have no natural way to
end a session early, so logout, a forced password reset, or an admin kicking a compromised device
would otherwise wait out the remaining TTL.

- **Key**: `auth:jti:denylist:<jti>`, one flat string per revoked token. Checked with `EXISTS`, so
  the lookup is O(1) — a set or hash would scale with the number of revoked tokens, on a path that
  runs for every authenticated request.
- **TTL**: `exp - now`, set at revocation time. Once the token would have expired anyway the entry is
  worthless and Redis drops it, so the keyspace stays bounded by the access-token TTL rather than
  growing with logout volume. Revoking an already-expired token writes nothing.

Not built on the helpers in `src/cache.ts`: those key everything under `sch:{schoolId}:…` because
they cache tenant data, whereas a `jti` is globally unique and the revocation check happens before
any tenant is established.

### Fail-closed, unlike the rate limiter

If Redis is unreachable, the denylist check throws and the request gets a **503**. The rate limiter
sitting next to it in the chain does the opposite and passes traffic through.

The asymmetry is deliberate. Throttling is availability tooling — failing open degrades gracefully.
Revocation is a security boundary: failing open there means every token anyone has logged out of
silently works again for as long as the outage lasts, with nothing in the logs to say so. Making an
outage visible downtime is the lesser failure.

The cost is real and worth stating plainly: a Redis outage takes `/api/*` down. If that trade ever
becomes unacceptable, the fix is a replicated denylist, not a fallback to open.

## Tenant isolation

This is what the whole middleware exists to protect.

```ts
// apps/api/src/db/tenant-tx.ts
await tx.unsafe("SET LOCAL ROLE studafy_app");
await tx`SELECT set_config('app.school_id', ${context.schoolId}, true)`;
```

```sql
-- db/migrations/000006_create_rls_helper.sql
CREATE POLICY tenant_isolation ON %I.%I AS PERMISSIVE FOR ALL TO PUBLIC
  USING (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK (school_id = current_setting('app.school_id')::uuid);
```

`current_setting` is called without `missing_ok`, so an unset GUC raises rather than matching
nothing — the policies fail closed. The chain is: signed `school_id` claim → `auth.schoolId` →
`app.school_id` GUC → every RLS predicate.

`AuthContext.schoolId` is therefore non-nullable by construction, which is why the middleware is
mounted deny-by-default on `/api/*` rather than opted into per route. A route that forgot to opt in
would reach `tenant-tx.ts` with no tenant at all.

## Middleware ordering

Registered in [`app.ts`](../../apps/api/src/app.ts) between the logger and the rate limiter:

```
requestId → cors → securityHeaders → csrf → locale → logger → [jwtAuth] → rateLimiter → routes
```

- **After `requestId`**: there must be a child logger to re-bind. The auth middleware re-childs it
  with `school_id`/`user_id` — the seam described in
  [SAD_28](../architecture/SAD_28_logging_conventions.md), where `requestId` binds both as `null` on
  the way in because no identity exists yet.
- **After `logger`**: a rejected request should still be logged.
- **Before `rateLimiter`**: `buildRateLimitKey` keys authenticated traffic on `schoolId:userId` and
  falls back to client IP otherwise. Mounted after the limiter, every user behind a shared NAT would
  collapse into one bucket.
- **After `csrf`**: which already exempts `Authorization: Bearer` requests.

[`context-cascade.test.ts`](../../apps/api/tests/auth/context-cascade.test.ts) pins this against the
real `createApp` stack, since ordering bugs are invisible to the unit tests.

## Rejection envelope

RFC 9457 `application/problem+json`, built by
[`errorHandlerMiddleware`](../../apps/api/src/middleware/errorHandler.ts):

```http
HTTP/1.1 401 Unauthorized
content-type: application/problem+json
www-authenticate: Bearer
x-request-id: 0f8b7c1e-...
```

```json
{
  "type": "about:blank",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Invalid authentication token",
  "code": "AUTH_TOKEN_INVALID",
  "request_id": "0f8b7c1e-..."
}
```

Only expiry is distinguished from the generic case, as `AUTH_TOKEN_EXPIRED` — the client's correct
response is to refresh, and saying so avoids a pointless re-login. Everything else collapses to
`AUTH_TOKEN_INVALID` on purpose: separating "bad signature" from "unknown kid" from "malformed
claims" in the response would tell an attacker which part of a forged token to fix next. The precise
reason is recorded server-side.

`request_id` matches the `X-Request-Id` header and the `request_id` field on every log line for the
request, and the log labels match the DB GUCs one-for-one, so one identifier joins an HTTP response
to a log line to an audit row.

### What is logged on failure

One `warn` line, `"authentication failed"`, with a `reason` field (`malformed`, `key`, `signature`,
`expired`, `claims`, `revoked`). **The token is never logged in any form** — it is a live credential
until it expires, and log sinks reach a wider audience than the request path it arrived on. There is
a test asserting the signature segment never appears in the captured output.

## Configuration

| Variable                       | Default       | Effect                                                                     |
| ------------------------------ | ------------- | -------------------------------------------------------------------------- |
| `JWT_ISSUER`                   | `studafy`     | Required `iss`.                                                            |
| `JWT_AUDIENCE`                 | `studafy-api` | Required `aud`.                                                            |
| `JWT_ACCESS_TTL_SECONDS`       | `900`         | Token lifetime, and the denylist's memory ceiling.                         |
| `JWT_KEY_ROTATION_INTERVAL_MS` | 7 days        | Rotation cadence.                                                          |
| `REDIS_URL`                    | unset         | Absent ⇒ no denylist ⇒ **revocation is not enforced**, warned per request. |

`createApp` mounts the middleware only when a `keyStore` is supplied. Without one there is nothing
to verify against, and mounting it anyway would answer every `/api/*` request with a 503.

## Testing

| Suite                                                                                                     | Covers                                                                  |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`tests/auth/jwt-auth.test.ts`](../../apps/api/tests/auth/jwt-auth.test.ts)                               | Rejection matrix, RFC 9457 envelope, context hydration, rotation window |
| [`tests/auth/denylist.test.ts`](../../apps/api/tests/auth/denylist.test.ts)                               | Key shape, TTL arithmetic, revocation boundary, fail-closed 503         |
| [`tests/auth/short-circuit.test.ts`](../../apps/api/tests/auth/short-circuit.test.ts)                     | Redis is untouched for any token that cannot verify                     |
| [`tests/auth/context-cascade.test.ts`](../../apps/api/tests/auth/context-cascade.test.ts)                 | Ordering in the real `createApp` chain; log correlation                 |
| [`tests/benchmark/jwt-auth-benchmark.test.ts`](../../apps/api/tests/benchmark/jwt-auth-benchmark.test.ts) | p95 latency budget                                                      |

```bash
bun test apps/api/tests/auth
JWT_AUTH_BENCHMARK=1 bun test apps/api/tests/benchmark/jwt-auth-benchmark.test.ts
```

The benchmark reports a **delta** between two apps identical but for the middleware, following
`security-chain-benchmark.test.ts` — an absolute figure on a shared CI runner mostly measures Hono's
dispatch. It uses an in-process denylist, so the number excludes Redis round-trip time; RTT is a
property of the deployment topology, not of this middleware.

Integration tests authenticate with real signed tokens via
[`tests/harness/request.ts`](../../apps/api/tests/harness/request.ts). The previous `x-test-school-id`
header shim was removed: it was registered last in the chain, so the auth context was invisible to
`requestId` and the rate limiter, and no test built on it could have caught an ordering regression.

## What does not exist

Worth being explicit, because the pieces above imply endpoints that are not here yet.

- **No login, logout, or refresh endpoints.** Nothing in the API mints a token for a real user.
  `signAccessToken` is called only by tests, and `denylist.revoke()` is exported for the logout
  ticket that will consume it. `app.refresh_tokens` exists in migration `000007` and is unused.
- **No persisted signing keys.** `KeyStore` is in-memory, so a restart invalidates every live token
  and a multi-instance deployment would have each instance signing with keys the others reject. This
  is the most significant open limitation; it needs a shared key backend before horizontal scaling.
- **No EdDSA.** ST-070 permitted RS256 _or_ EdDSA; `KeyStore` is RS256-only.
- **No per-permission authorization.** `roles` reaches the context and stops there. `ROLE_PERMISSIONS`
  in `@studafy/constants` is not enforced by anything, and there is no `requireRole` guard yet —
  `requireAuth` only asserts that a session exists.
- **No token binding.** Nothing ties a token to a device, IP, or TLS session; a stolen token is
  usable by anyone holding it until it expires or is revoked.
