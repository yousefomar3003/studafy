# Session model

How a Studafy session is established, renewed, and ended. The implementation is
[`apps/api/src/modules/auth/services/session-service.ts`](../../apps/api/src/modules/auth/services/session-service.ts),
[`apps/api/src/modules/auth/tokens/opaque-token.ts`](../../apps/api/src/modules/auth/tokens/opaque-token.ts),
[`apps/api/src/modules/auth/delivery.ts`](../../apps/api/src/modules/auth/delivery.ts), and
[`db/migrations/000029_add_refresh_token_session_columns.sql`](../../db/migrations/000029_add_refresh_token_session_columns.sql)
over the table created by
[`000007`](../../db/migrations/000007_create_users_and_identity_tables.sql). This document explains
the design; those files are the source of truth for its behaviour.

## Stated assumption on the session specification

The ST-071 ticket cites **SAD section 13** as the source of the session and authentication lifecycle
requirements. **The SAD is not in this repository.** The design below is taken from the ticket's own
stated requirements, from the token-family model already committed in `000007` and described in
[`docs/api/auth-data-model.md`](../api/auth-data-model.md), and from
[ADR 0006](../adr/0006-identity-tokens-and-tenant-rls.md). **This document does not claim that the
unavailable SAD text was inspected.** If the SAD later contradicts it, a follow-up ticket reconciles
the two. `SAD_28_logging_conventions.md`, `000018`, and `docs/api/global-data-erd.md` all record the
same gap for their own sections.

## Two token types, for two different reasons

|                    | Access token                                        | Refresh token                                |
| ------------------ | --------------------------------------------------- | -------------------------------------------- |
| Format             | RS256 JWT                                           | Opaque `<school>.<user>.<secret>`            |
| Carries claims     | Yes — `sub`, `school_id`, `roles`, `channel`, `jti` | No                                           |
| Verified by        | Signature, offline                                  | Database lookup                              |
| Lifetime           | 15 min (`JWT_ACCESS_TTL_SECONDS`)                   | 30 days, sliding (`JWT_REFRESH_TTL_SECONDS`) |
| Revocable          | Only via the `jti` denylist                         | Yes, immediately                             |
| Stored server-side | No                                                  | SHA-256 of the secret half only              |

The split is the usual one and worth stating plainly: a JWT is fast because nothing is consulted to
prove it valid, which is exactly why it cannot be withdrawn. The refresh token is the opposite trade
— every use costs a lookup, and in exchange a session can be ended the instant it needs to be.

## The wire format, and why it carries two ids

```
22222222-2222-...-2222 . 11111111-1111-...-1111 . Xk7__pQ2mF1nR8sTvW4yZ6bC9dE0gH3jK5lM7oP1qS8
└─ school_id ─────────┘  └─ user_id ───────────┘  └─ secret ─────────────────────────────────┘
                                                     256 bits of CSPRNG output, base64url
```

The secret alone would be a perfectly good credential. The two ids are there to solve an _ordering_
problem in the data layer, not a cryptographic one.

A refresh request carries no access token — that is the situation it exists to resolve — so it has
no verified `school_id`. But [`withTenantTx`](../../apps/api/src/db/tenant-tx.ts) cannot open a
transaction without one, and every policy created by
[`000006`](../../db/migrations/000006_create_rls_helper.sql) compares rows against
`current_setting('app.school_id')` with no `missing_ok`, so an unset GUC **raises** rather than
matching nothing. The restrictive `refresh_tokens_owner` policy makes the same true of
`app.user_id`. Both have to be known _before_ the row that holds them can be read.

**This discloses nothing.** The access token issued to the same client already carries `school_id`
and `sub` as claims. Nor does it hand a caller a scope to attack: forged ids open a transaction
scoped to that tenant and user, where the presented secret still has to hash to a stored
`token_hash` owned by them. Wrong ids find nothing.

```mermaid
sequenceDiagram
    participant C as Client
    participant R as POST /api/auth/refresh
    participant T as app.refresh_tokens<br/>(tenant + owner RLS)

    C->>R: school.user.secret
    R->>R: parse; reject malformed in-process
    Note over R,T: withTenantTx(school_id, user_id) — studafy_app, all policies in force
    R->>T: SELECT … WHERE token_hash = sha256(secret)
    Note right of R: finding a row IS the verification
    R->>T: INSERT child; UPDATE parent … AND rotated_at IS NULL
    R-->>C: new pair
```

### Two designs that do not work

Recorded so they are not attempted again; the migration header carries the same note.

**A `SECURITY DEFINER` function reading `app.refresh_tokens`.** `apply_tenant_isolation` creates
`tenant_isolation` as `PERMISSIVE FOR ALL TO PUBLIC` _and_ applies `FORCE ROW LEVEL SECURITY`, so the
owning role is subject to the policy too — and this schema deliberately has no `BYPASSRLS` role
(`000002` refuses to proceed if either role carries the attribute, `000022` states it, and
`packages/db/tests/rls.test.ts` asserts it stays false). The function would be filtered by the same
unset GUC and fail closed. That is the isolation guarantee working as designed.

**A global directory mapping an opaque locator to `(school_id, user_id)`**, so the token would carry
no tenant identifier. This is the shape [`000028`](../../db/migrations/000028_create_security_events_table.sql)
used for `app.security_events`, and it does not transfer: `security_events` carries no `school_id` at
all, whereas a directory whose whole purpose is to _return_ one must.
[`db/policies/rls-coverage.ts`](../../db/policies/rls-coverage.ts) rejects exactly that combination —
`GLOBAL_SCOPE_DRIFT`, _"approved global table unexpectedly contains school_id"_ — and `000028`'s own
header names it in advance as "the worst of both worlds". A table in this schema either carries
`school_id` and is tenant-isolated, or carries none and is global. There is no third category, and
inventing one for this feature would weaken the invariant that makes NFR-05 provable.

## Session state

A session is a `family_id`. Each token in it is one row, and the chain is linked by
`parent_token_id` / `replaced_by_token_id`.

| State    | `rotated_at` | `revoked_at` | Meaning                                                   |
| -------- | ------------ | ------------ | --------------------------------------------------------- |
| Live     | null         | null         | The tip of the chain. Exactly one per family.             |
| Consumed | set          | null         | Superseded by a child. Presenting it again is a breach.   |
| Revoked  | either       | set          | Dead. Reached by logout, termination, or reuse detection. |
| Expired  | null         | null         | Live-looking, but `expires_at <= now()`.                  |

Expiry is evaluated in the authenticating transaction, never by a constraint or a partial index — a
`now()`-relative predicate is not immutable and cannot appear in an index. `000007` records the same
constraint for `uq_invitations_active`.

The window **slides**: each child gets a fresh 30 days, so a session in continuous use never expires
and 30 days of silence ends it.

## Rotation and reuse detection

Every refresh consumes the presented token. A token is valid exactly once.

Re-presenting a consumed token means two parties hold it, which does not happen without a theft. The
response is to burn the whole family:

1. `UPDATE app.refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`
2. Revoke the linked `app.user_devices` row, if there is one — otherwise a stolen handset keeps
   receiving push notifications.
3. Write an `app.audit_logs` row with `action = 'logout'`, `target_id = family_id`, and
   `reason: "refresh_token_reuse_detected"`.
4. Log at **error** level, keyed by `family_id`.
5. Answer `401 AUTH_TOKEN_INVALID`.

All four database effects are in one transaction. `emitAuditLog` throws on failure, which rolls the
revocation back with it: a revocation nobody can prove happened is worse than one that visibly
failed.

**The legitimate holder is logged out too.** That is the correct outcome, and the reason rotation is
worth its cost — the alternative is an attacker who rotates silently forever.

Two ordering details carry weight:

- **Reuse is checked before expiry.** A replayed token that has also aged out is still a theft
  signal; reporting it as merely "expired" would let an attacker who sat on a stolen token past its
  lifetime avoid tripping the alarm entirely.
- **The secret is what finds the row, so no lifecycle state is reachable without it.** The lookup
  matches on the digest, so a caller holding only a school and user id — both of which the access
  token already publishes — cannot learn that a session exists, or that it was revoked.

### Concurrency

Two requests presenting the same token serialize on `SELECT … FOR UPDATE`. The winner inserts one
child and consumes the parent through one guarded data-modifying CTE. The waiter then reads the
committed consumed state and burns the family as reuse. Without the row lock and guarded update both
requests could succeed and fork the family into two live branches.

A genuine double-submit and a real attacker are indistinguishable here. Resolving that ambiguity in
favour of the family is the premise of rotation, so an over-eager client that fires two refreshes at
once will lose its session. Clients must serialize refreshes.

## Delivery

`app.refresh_tokens.channel` is fixed when the session is established and copied unchanged onto every
child.

| Channel         | Refresh token delivered as                                                 | Rationale                                                                                              |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `web`           | `Set-Cookie: session=…; HttpOnly; Secure; SameSite=Strict; Path=/api/auth` | A browser can be scripted by an XSS payload, so the token must be somewhere JavaScript cannot read it. |
| `mobile`, `api` | `refresh_token` in the response body                                       | No DOM, no `document.cookie` — a native client needs to read the token to put it in the OS keychain.   |

Three details that are load-bearing rather than incidental:

- **The channel is read from the row, never from a request header.** A header would let a caller ask
  for a web session's token in the response body — precisely the read an XSS payload needs, and
  precisely what `HttpOnly` exists to prevent. The attacker would simply opt out of the defence.
- **A web response omits `refresh_token` entirely.** Setting the cookie _and_ returning the value
  would make `HttpOnly` decorative.
- **The cookie is read in preference to the body.** If both are present, the cookie is what the
  browser attached automatically and the body is attacker-supplied.

`Path=/api/auth` scopes the cookie to the only two endpoints that consume it, so it rides on no other
request. `Secure` is off only in development and test, where there is no TLS to attach it to;
`getSecurityConfig()` treats `NODE_ENV=test` as its own arm, so a deployed tier cannot lose it
through an `APP_ENV` misconfiguration.

## Endpoints

| Route                                          | Auth          | Notes                                |
| ---------------------------------------------- | ------------- | ------------------------------------ |
| `POST /api/auth/refresh`                       | Refresh token | Exempt in `DEFAULT_PUBLIC_PATHS`     |
| `POST /api/auth/logout`                        | Refresh token | Always 200, whatever was presented   |
| `GET /api/auth/sessions`                       | Bearer        | One entry per session, not per token |
| `DELETE /api/auth/sessions/{sessionId}`        | Bearer        | Revokes the whole family             |
| `DELETE /api/auth/devices/{deviceId}/sessions` | Bearer        | For a lost device                    |

`/api/*` is deny-by-default under `jwtAuthMiddleware`, so the first two are listed in
`DEFAULT_PUBLIC_PATHS` — a client reaches them precisely when its access token is gone, and requiring
one would make them unreachable exactly when they are needed. The exemption matches **whole path
segments**, so `/api/auth/sessions` stays behind the boundary and a hypothetical
`/api/auth/refresh-everything` would not be opened by the `/api/auth/refresh` entry.

Both are also exempt from the CSRF double-submit check, for the same underlying reason: a client
calls them when its access token is gone, so the Bearer exemption frequently does not apply, and a
mobile client refreshing with the token in the body carries no cookie for an attacker to forge with.
The browser case rests on the refresh cookie's `SameSite=Strict` attribute, which keeps it off every
cross-site request. See [`web_defense_matrix.md`](../security/web_defense_matrix.md) and the
rationale on `EXEMPT_PATHS` in `src/middleware/csrf.ts`.

Responses that reveal nothing are deliberate throughout: logout answers identically for a valid,
unknown, or absent token, and session termination answers `revoked: 0` whether the session does not
exist or belongs to someone else. The per-user RLS fence makes those two cases indistinguishable to
the query as well as to the caller.

## Storage

`app.refresh_tokens` is 3NF with no serialized blobs — device metadata is explicit scalar columns
(`device_name`, `user_agent`, `ip_address`), per `000007`.

`000029` adds `device_id` (composite FK to `app.user_devices`, **nullable**) and `channel`. `device_id` is nullable because `app.user_devices`
is an FCM push-token registry rather than a session-fingerprint table: a browser login that never
granted push has no row there, and forcing the link would mean minting a synthetic push registration
per browser session, corrupting that table's meaning for the notification code that owns it.

### Row-level security

Two policies, and they AND together:

- `tenant_isolation` (permissive, from `000007`) — fences rows to their school.
- `refresh_tokens_owner` (**restrictive**, from `000029`) — fences rows to their owning user.

The table previously carried tenant isolation only, which for a credential store is too weak: any
authenticated session in a school could read, and revoke, every other user's sessions in that school.
The restrictive policy is scoped `TO studafy_app` rather than `PUBLIC`, matching the shape `000017`
uses for `user_devices`.

> **Consequence for callers, and it is not optional.** `app.current_user_id()` reads
> `current_setting('app.user_id')` with no `missing_ok`, so it raises `42704` when the GUC is unset
> rather than matching nothing. **Every `withTenantTx` call touching this table must pass `userId`.**
> The failure is closed and loud, which is the intent — but a caller that forgets gets an error, not
> an empty result set.

### Indexes

| Index                                               | Query it serves                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `uq_refresh_tokens_token_hash`                      | Unique B-tree on the digest — the point lookup every rotation performs (`000007`) |
| `idx_refresh_tokens_school_family`                  | Family revocation                                                                 |
| `idx_refresh_tokens_school_user`                    | A user's tokens; backs the composite FK                                           |
| `idx_refresh_tokens_school_parent` / `_replaced_by` | Chain traversal; back the self FKs                                                |
| `idx_refresh_tokens_school_device`                  | Per-device enumeration and termination                                            |
| `idx_refresh_tokens_school_user_active`             | Live-session listing (partial)                                                    |

## Performance

The acceptance target is **under 5 ms** for validation, the transactional state transition, and
minting the replacement pair, under parallel load.

The benchmark is
[`apps/api/tests/benchmark/refresh-rotation-benchmark.test.ts`](../../apps/api/tests/benchmark/refresh-rotation-benchmark.test.ts),
gated in CI on `REFRESH_ROTATION_BENCHMARK=1`. It measures 1,000 rotations at 16-way concurrency and
asserts the **median**, reporting p95 without gating on it. Its disposable client uses the same
sixteen-connection capacity as the production API pool, so the contention it records represents the
deployed configuration instead of the four-connection default used by ordinary integration tests.

An **absolute** budget, unlike the delta-based middleware benchmarks next door. Rotation has no
baseline arm to subtract, and its cost is dominated by database round trips rather than framework
overhead, so it follows the precedent of the absolute budgets in `packages/db/tests` (see
[`docs/database/attendance.md`](../database/attendance.md)).

Covered: token parse, one SHA-256 digest, and the single lock-protected tenant transaction that reads
the session and roles, then signs the access token concurrently with the guarded CTE that inserts the
child and consumes the parent. Commit follows only after both operations succeed, so either failure
rolls the state transition back. Excluded: client network RTT, a property of deployment topology.

Reproduce:

```sh
TEST_DATABASE_URL=... REFRESH_ROTATION_BENCHMARK=1 \
  bun test tests/benchmark/refresh-rotation-benchmark.test.ts --timeout 180000
```

## Logging

No token material reaches a log sink in any form — not the presented token, not the secret, not the
digest. The school and user ids in a token are not credentials and appear in log lines as ordinary
correlation fields; the secret never does.

Correlation keys are `family_id` and `session_id`. A reuse breach logs at **error**; a theft signal
that lands at `warn` gets lost among ordinary 401s.
`apps/api/tests/auth/session-http.test.ts` asserts the negative directly, following the pattern in
`tests/security/csrf.test.ts`.

## What does not exist

- **No login route.** Nothing mints a first token pair. `issueTokenPair()` is the seam a future
  login ticket calls; `app.users` has no password columns, so credential verification is out of scope
  here.
- **Revoking a session does not invalidate its access token.** The access token stays valid for up to
  `JWT_ACCESS_TTL_SECONDS` (900 by default) after the session ends. Closing that window needs an
  `access_jti` column on the session row so termination can also call
  `denylist.revoke()` — the Redis machinery already exists
  ([`modules/auth/denylist.ts`](../../apps/api/src/modules/auth/denylist.ts)); only the plumbing to
  reach another session's `jti` is missing. **This is the largest known gap.**
- **No absolute cap on a family's lifetime.** The 30-day window slides indefinitely, so a session in
  continuous use never forces re-authentication.
- **No expiry reaper.** Consumed and expired rows accumulate; a 30-day session leaves one row per
  rotation behind it. `idx_refresh_tokens_school_user_active` is partial partly in anticipation of
  that, but nothing deletes yet.
- **No per-tenant session security events.** `000028`'s header directs these to a new tenant-scoped
  relation rather than to `app.security_events`; reuse breaches currently land in `app.audit_logs`
  and the structured log.
- **`entitlements_ver` is hardcoded to 1** at issuance. There is no entitlements versioning source
  yet.
