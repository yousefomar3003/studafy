# ADR-014: JWT strategy — RS256, rotated keys, denylistable jti

## Status

Accepted

## Context

SAD_13 and the session model ([`docs/architecture/SAD_13_session_model.md`](../architecture/SAD_13_session_model.md))
establish two token types: an **access token** that must be verifiable without any storage lookup
(so it can ride every request cheaply), and a **refresh token** that must be revocable (so a session
can be ended the instant it needs to be). The access token is a JWT; this ADR records exactly what
kind of JWT, how keys are held and rotated, what claims it carries, and how revocation and
staleness are handled. The opaque refresh-token side (hashing, family rotation) is covered by
ADR-0006; this ADR is the access-token strategy.

## Decision

- **Asymmetric RS256, verified offline.** Access tokens are signed with RSA-2048 (`alg: RS256`) via
  `jose` (`src/modules/auth/jwt/{sign,verify,key-store}.ts`) and verified with the public key alone —
  no database, no Redis, no per-request network call. This is the point of a JWT over an opaque
  DB-backed token: nothing is consulted to prove it valid.
- **Keys live in an in-process `KeyStore` with automatic rotation.** The store holds at most two
  key pairs: `current` (signs + verifies) and `previous` (verifies only, for tokens still in flight
  under the old key). Rotation runs on an interval, generates a fresh pair with a new `kid`, and the
  `jwks` endpoint (`src/modules/auth/jwks/route.ts`) exposes both public keys so old tokens stay
  verifiable until they expire. Verification resolves the token's `kid` to one key (`byKid` cache)
  and checks a single signature — an unknown `kid` is treated exactly like a bad signature.
- **Claims.** `sub` (user id), `school_id`, `roles`, `channel` (ADR-0016), `entitlements_ver`,
  `subscription_status`, plus standard `iss`, `aud`, `iat`, `exp`, `nbf`, and `jti` (a v4 UUID,
  carried so revocation can deny one token without waiting for expiry). TTL is
  `JWT_ACCESS_TTL_SECONDS` (default 900 s).
- **Revocation is bounded, and that bound is accepted.** An access token cannot be withdrawn by
  shrinking the TTL; revocation happens on the `jti` denylist (Redis, `src/modules/auth/denylist.ts`),
  which `jwtAuthMiddleware` consults. Everything is consistent with the stated trade in SAD_13:
  "a JWT is fast because nothing is consulted to prove it valid, which is exactly why it cannot be
  withdrawn."
- **Staleness is solved with a version claim, not by shortening TTLs.** The token carries
  `entitlements_ver`; when the stored version for the subject is newer (subscription change, ST-133),
  verification returns `AUTH_ENTITLEMENTS_STALE` and the client refreshes (SAD_16). This is what
  makes `reset lifetime`-style revocations unnecessary for the common case.
- **The authentication boundary is one middleware.** `jwtAuthMiddleware` holds `/api/*` deny-by-
  default, verifies the signature + claims, checks the denylist, resolves the active entitlements,
  and treats unknown channels/roles as rejection (fail closed). Public paths are explicit
  allow-lists matching whole path segments.
- **Performance is a tracked budget.** `apps/api/tests/benchmark/jwt-auth-benchmark.test.ts` keeps
  verification on the hot path honest — measured at ~0.3 ms p95 in the repo's benchmarks,
  dominated by the RSA verify and never by key loading (the JWKS export is memoized per rotation).
  The refresh-rotation benchmark (SAD_13) covers the full issue + rotate path.

## Alternatives considered

- **Symmetric HMAC (HS256)** — one shared secret, no public verification, and every consumer
  holding the secret is a signing party. Rejected: verification happens in services that must not be
  able to forge tokens.
- **Remote JWKS fetch on every verification** — correct but introduces a network dependency on the
  hottest path and a new failure mode (cache-miss on auth). Rejected in favour of the in-process
  store; the JWKS endpoint still exists for external consumers.
- **Opaque access tokens with a database lookup** — gives immediate revocation, but makes "verify
  this token" a query on every request and reintroduces exactly the storage-in-the-hot-path cost the
  access/refresh split exists to avoid. Rejected; revocation is the refresh side's job.
- **Session-only (cookie) auth with no access token** — unworkable for native mobile and
  server-to-server callers (ADR-0016); the token exists to be portable across those surfaces.
- **A stateless JWT with no denylist at all** — simplest, but logout and device revocation
  (SAD_13) could then only "expire", and the 15-minute residual window for a terminated session would
  be unbounded. The denylist is the accepted middle: full revocation where the refresh token reaches
  it, and a bounded window where only the access token exists.

## Consequences

- Verification is offline and cheap, which is what keeps auth off every request's critical latency.
- Key rotation is automatic and overlapping: the previous key is kept until its pinned tokens expire,
  so a rotation is never a logout event.
- Revocation has two tiers everyone must understand: refresh-side immediate (family burn), access-
  side bounded (denylist + TTL). A 15-minute access token after logout is the designed residual
  window, not a bug.
- Claims are a fixed, versioned vocabulary; adding a claim is a coordinated change (sign sites,
  verification, benchmarks) because every consumer depends on the shape.

## Review

Reviewed by `baderalhindi` on 2026-09-11.
