# Device revocation and logout

How a session is torn down, and why ending one takes two stores rather than one. Delivered by
ST-072, which connected the refresh-token families from ST-071 to the Redis `jti` denylist from
ST-070 — the two shipped separately and, until this ticket, were never wired together.

The guarantee: a revoked credential stops working on **every** API instance within one Redis round
trip, against a stated budget of 5 seconds.

## The problem this solves

A session is two credentials with very different properties.

|             | Refresh token                       | Access token                          |
| ----------- | ----------------------------------- | ------------------------------------- |
| Storage     | Row in `app.refresh_tokens`         | Nothing — self-contained JWT          |
| Lifetime    | 30 days (`JWT_REFRESH_TTL_SECONDS`) | 15 minutes (`JWT_ACCESS_TTL_SECONDS`) |
| Revocation  | Set `revoked_at`                    | Nothing to set                        |
| Verified by | A database lookup                   | A signature check                     |

Before ST-072, logout did the first column and ignored the second. The refresh token died
immediately, but the access token already in the client's hands stayed cryptographically valid until
its own `exp` — so a stolen token survived a logout by up to fifteen minutes, and
[`revoke()`](../../apps/api/src/modules/auth/denylist.ts) on the denylist built for exactly this
purpose had **no production caller at all**.

A second gap sat underneath the first: `jti`s were never persisted.
[`signAccessToken`](../../apps/api/src/modules/auth/jwt/sign.ts) minted one with `randomUUID()` per
call and discarded it, so nothing recorded which access tokens were outstanding for a user. There
was no way to answer "deny the tokens this session issued", because nothing knew what they were.

## Dual-layer teardown

Every revocation path funnels through
[`revokeAndDenylist`](../../apps/api/src/modules/auth/services/revocation-service.ts) so the window
above cannot reopen one route at a time.

1. **PostgreSQL, in one transaction.** Mark the token families revoked and write the `app.audit_logs`
   row. `emitAuditLog` throws on failure and rolls the revocation back with it — a revocation nobody
   can prove happened is worse than one that visibly failed. This is the rule
   [`revokeReusedSession`](../../apps/api/src/modules/auth/services/session-service.ts) established
   in ST-071.
2. **Redis, after the commit.** Pipeline the `access_jti` values the UPDATE returned into the shared
   denylist, each with `TTL = exp - now`.

### Why Postgres commits first

The two stores cannot be made atomic with each other, so the only real question is which
inconsistency to prefer when the second step fails. They are not symmetric:

- **Commit, then denylist** can leave a revoked family whose access token is briefly still live.
  That is the pre-ST-072 status quo for at most one access-token TTL, it is loud (the service throws
  a 503), and the refresh path is already closed so the session cannot extend itself.
- **Denylist, then commit** can deny tokens for a transaction that then rolls back — logging a user
  out of a session the database still considers live, with no audit record of why.

A denylist write that fails after a committed revocation is **never swallowed**. It logs at `error`
and raises a 503: the durable half succeeded, the propagation half did not, and answering 200 would
tell a caller their stolen token was killed when it was not. Every statement is idempotent under
`revoked_at IS NULL`, so the operation is safe to retry.

## Tracking the access token

Migration
[`000030`](../../db/migrations/000030_add_access_jti_and_admin_revocation.sql) adds two columns to
`app.refresh_tokens`:

```sql
ALTER TABLE app.refresh_tokens ADD COLUMN access_jti uuid;
ALTER TABLE app.refresh_tokens ADD COLUMN access_expires_at timestamptz;

ALTER TABLE app.refresh_tokens
  ADD CONSTRAINT ck_refresh_tokens_access_token
  CHECK ((access_jti IS NULL) = (access_expires_at IS NULL));
```

Each row is one refresh token, minted alongside exactly one access token. Recording that token's
identity turns "revoke this family" into "and here are the `jti`s to deny" — a projection of
`UPDATE … RETURNING` rather than a lookup against a second registry.

A few points that are easy to get wrong:

- **A `jti` is not a credential.** It appears in plaintext inside every token that carries it, is not
  secret, and is not sufficient to construct a token. Unlike `token_hash` next door it needs no
  digesting.
- **`access_expires_at` is stored, not derived.** `JWT_ACCESS_TTL_SECONDS` is configuration and can
  change between deployments, so `issued_at + TTL` would compute the wrong expiry for every token
  minted under a previous value. A wrong value here either drops the denylist entry while the token
  is still live (an authentication bypass) or pins it long after the token is worthless (unbounded
  growth).
- **Both are nullable.** Rows written before `000030` have no `jti` to record and are not
  backfillable — the value was never persisted anywhere. Such sessions are still revoked in
  Postgres; only the outstanding access token has to age out on its own.

The `jti` is generated by the session service and passed into `signAccessToken` via its `jti`
option, rather than returned from it. That keeps the signature of a function with ~20 call sites
unchanged for the benefit of the two that need it.

## Key format and TTL

Unchanged from ST-070 — see [JWT verification architecture](./JWT_verification_architecture.md).

| Property     | Value                     |
| ------------ | ------------------------- |
| Key          | `auth:jti:denylist:<jti>` |
| Value        | `1`                       |
| TTL          | `exp - now`, in seconds   |
| Lookup       | `EXISTS`, O(1)            |
| Skipped when | `TTL <= 0`                |

Self-pruning is what bounds the keyspace by the access-token TTL rather than by logout volume: once
a token would have expired anyway, the entry is worthless and Redis drops it. No sweeper task
exists, and none is needed.

[`revokeMany`](../../apps/api/src/modules/auth/denylist.ts) pipelines a batch into a single round
trip. Each `SET` is already O(1) server-side, so the network trip is the dominant cost — pipelining
makes a global logout cost one trip regardless of how many sessions the account has. ioredis reports
per-command failures inside the results array instead of rejecting, so `revokeMany` inspects every
tuple and rethrows the first error rather than reporting a success that did not happen.

## Endpoints

| Method   | Path                                           | Auth                    | Scope                                      |
| -------- | ---------------------------------------------- | ----------------------- | ------------------------------------------ |
| `POST`   | `/api/auth/logout`                             | Refresh token           | The presented token's family               |
| `GET`    | `/api/auth/devices`                            | Bearer                  | Caller's registered devices                |
| `DELETE` | `/api/auth/devices/{deviceId}`                 | Bearer                  | Device's sessions **and** its registration |
| `DELETE` | `/api/auth/devices/{deviceId}/sessions`        | Bearer                  | Device's sessions only                     |
| `DELETE` | `/api/auth/sessions/{sessionId}`               | Bearer                  | One session's family                       |
| `DELETE` | `/api/admin/users/{userId}/devices`            | Bearer + `user:suspend` | Every family the user holds                |
| `DELETE` | `/api/admin/users/{userId}/devices/{deviceId}` | Bearer + `user:suspend` | One device of another user                 |
| `GET`    | `/api/admin/users/{userId}/sessions`           | Bearer + `user:suspend` | Another user's active sessions             |
| `GET`    | `/api/admin/users/{userId}/devices`            | Bearer + `user:suspend` | Another user's registered devices          |

The two `GET` rows are ST-187, added for the user-management screens' deactivation dialog and
per-user device-sessions panel — an administrator could already revoke another user's sessions blind
(the rows above), but had no way to see what a revocation would affect first. `GET
/api/auth/sessions` and `/devices` cannot answer for another user for the same reason the admin
`DELETE` routes could not use `revokeAndDenylist`: `refresh_tokens_owner` (000029) is RESTRICTIVE and
scoped `TO studafy_app`, so a plain query only ever sees the caller's own rows. Migration `000100`
adds `app.admin_list_user_sessions` and `app.admin_list_user_devices`, read-only SECURITY DEFINER
functions owned by `studafy_admin` — the same seam `app.admin_revoke_user_sessions` uses, applied to
a read instead of a write, with the same cross-tenant behavior: a target in another school answers
200 with an empty list, not 404 or 403.

`/api/auth/logout` is exempt from the authentication boundary via `DEFAULT_PUBLIC_PATHS` in
[`jwtAuth.ts`](../../apps/api/src/middleware/jwtAuth.ts) — it is reached precisely when the access
token is already gone, so requiring one would make it unreachable exactly when a client needs it.
The refresh token is the credential.

Because there is no auth context on that route, the `jti`s to deny come from the revoked family's
own rows rather than from an `Authorization` header. That is more reliable, not merely more
convenient: a client logging out after its access token expired sends no bearer at all, and one
logging out from a different tab may send a token belonging to a different session.

**Revocation is always family-wide.** Revoking the single matched row would leave the rest of the
rotation chain intact and the session refreshable, since the client holds the live tip.

## Authorization

[`requirePermission`](../../apps/api/src/middleware/authz.ts) is the first consumer of
`ROLE_PERMISSIONS` from `@studafy/constants`, which had existed unused since ADR
[0002](../adr/0002-fixed-roles-authorization.md). Until ST-072 the only authorization in the API was
the `/api/*` prefix boundary — deny-by-default at the edge and allow-all past it, which was adequate
while every route operated on the caller's own rows.

The admin routes gate on `PERMISSIONS.USER_SUSPEND`, held by `SUPER_ADMIN` and `ORG_ADMIN`.
Terminating every credential a user holds is operationally indistinguishable from suspending them,
and minting a new permission constant would widen a shared package for a distinction no role
definition currently draws.

Two details worth keeping:

- **401 outranks 403.** An unauthenticated caller gets 401, never 403 — otherwise the status code
  alone would tell an anonymous prober that a route exists and what it requires.
- **The response never names the missing permission.** It goes to the log instead. A client that
  legitimately lacks a permission can do nothing differently with its name, while a prober could map
  the whole matrix from it.

## Crossing the RLS fence for admin routes

Migration `000029` installs `refresh_tokens_owner`, a **restrictive** policy comparing `user_id` to
`app.current_user_id()`. An administrator terminating another user's sessions is by construction
reaching for rows that policy hides.

Opening the tenant transaction as the _target_ user would evade the policy and is deliberately not
done: [`auditEmitter.ts`](../../apps/api/src/middleware/auditEmitter.ts) reads `actor_id` from the
`app.user_id` GUC, so that shortcut would file every forced logout as though the victim had
performed it — destroying the audit trail exactly where it matters most.

Instead `000030` adds `app.admin_revoke_user_sessions`, a `SECURITY DEFINER` function owned by
`studafy_admin`. This is the maintenance path `000029` left open on purpose, whose header records:
_"naming the runtime role keeps the fence on every application query while leaving a
studafy_admin-owned maintenance path available. Nothing uses that path today."_ This is its first
user.

The function drops the per-user fence and keeps the per-tenant one:

- `refresh_tokens_owner` names only `studafy_app`, so it does not bind a `studafy_admin`-owned
  function.
- `tenant_isolation` is `PERMISSIVE FOR ALL TO PUBLIC` under `FORCE ROW LEVEL SECURITY`, so it
  **does** bind the owner — and that is the property being relied on. Every statement is additionally
  scoped to `current_setting('app.school_id')::uuid`, making a cross-tenant revocation
  unrepresentable rather than merely unauthorized.

This is not the design `000029`'s header rules out. That entry rejects a `SECURITY DEFINER` function
for the _unauthenticated refresh_ path, where no tenant is established and the GUC would be unset.
Here the caller is a fully authenticated administrator and `app.school_id` is set to their school.

## Cross-tenant targets answer 200 with zero

An administrator in school A naming a user in school B gets the same empty result as one naming a
UUID that exists nowhere. Not a 403, and not a 404 — both would confirm the id names something real.

This is the same non-enumerable convention the self-service routes use (`revoked: 0` for a device
that does not exist _or_ belongs to someone else). Distinguishing the cases would hand any org admin
an oracle for probing which user ids exist in other tenants, which is precisely the cross-tenant ID
harvesting [NFR-05](./NFR-05_cross_tenant_isolation.md) exists to prevent.

## Indexing

`000030` adds exactly one index, and the omission is the more interesting half.

```sql
CREATE INDEX idx_refresh_tokens_school_user_device_active
  ON app.refresh_tokens (school_id, user_id, device_id)
  INCLUDE (access_jti, access_expires_at)
  WHERE revoked_at IS NULL;
```

Family-scoped revocation — every logout, every single-session termination — is already served by
`idx_refresh_tokens_school_family` from `000007`, created for exactly that purpose. A partial,
`INCLUDE`-carrying variant was drafted and dropped: revocation is an `UPDATE`, so the heap must be
visited to write `revoked_at` regardless, which means `INCLUDE` can never make the `RETURNING`
projection index-only. It would have cost writes on every insert to buy a marginally smaller index
for a query shape already covered.

The index above has no such predecessor, and does **not** duplicate
`idx_refresh_tokens_school_user_active` from `000029`. That one is additionally partial on
`rotated_at IS NULL`, so it excludes rotated-but-not-revoked rows — which are exactly the rows this
query must reach. A rotated refresh token is spent, but the _access_ token it minted on the way past
can easily still be live, and skipping those rows would leave behind precisely the credentials
revocation exists to kill.

Neither predicate mentions `expires_at`: a `now()`-relative expression is not immutable and cannot
appear in an index. Expiry is evaluated in the revoking transaction.

## Audit trail

Every teardown writes one `app.audit_logs` row inside the revoking transaction.

`app.audit_action` is a closed enum whose nearest label is `logout`, and every teardown is a logout
in the sense that enum means. The distinction lives in a `reason` field on the payload instead,
extending the vocabulary `session-service.ts` already writes:

| `reason`                       | Written by                                            |
| ------------------------------ | ----------------------------------------------------- |
| `logout_single`                | `POST /api/auth/logout`                               |
| `revoke_session`               | `DELETE /api/auth/sessions/{sessionId}`               |
| `revoke_device`                | Either `/api/auth/devices/…` route                    |
| `admin_revoke_device`          | `DELETE /api/admin/users/{userId}/devices/{deviceId}` |
| `admin_revoke_all_devices`     | `DELETE /api/admin/users/{userId}/devices`            |
| `refresh_token_reuse_detected` | ST-071 reuse detection                                |

Extending the enum was considered and rejected: `ALTER TYPE … ADD VALUE` carries transaction
restrictions, and every existing audit reader would have to widen, for no gain a queryable JSON field
does not already provide.

Audit queries must carry a `created_at` bound or they probe every monthly partition — see
[audit-logs-data-model.md](../database/audit-logs-data-model.md).

## Degraded modes

| Condition                             | Behaviour                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Redis unconfigured (`denylist: null`) | Postgres revocation proceeds; a warning is logged per teardown. Matches how `jwtAuth.ts` degrades. Access tokens age out naturally. |
| Redis unreachable during a lookup     | **Fail closed** — 503 from the middleware. Failing open would resurrect every logged-out session for the outage.                    |
| Redis unreachable during a write      | 503 from the revocation service, after the Postgres half committed. Safe to retry.                                                  |
| Session predates `000030`             | Revoked in Postgres; nothing to denylist.                                                                                           |

## Run locally

```bash
POSTGRES_PASSWORD=studafy_local docker compose -f db/compose.yml up -d --wait

export TEST_DATABASE_URL='postgresql://studafy_test:studafy_local@127.0.0.1:54329/postgres?sslmode=disable'
export TEST_REDIS_URL='redis://127.0.0.1:6390'

# The ST-072 suite. Skips entirely without TEST_REDIS_URL — the propagation
# assertions are meaningless against an in-process fake.
bun test --cwd apps/api ./tests/auth/revocation.test.ts --timeout 90000

# Unit layers, no containers required.
bun test --cwd apps/api ./src/middleware/authz.test.ts ./tests/auth/denylist.test.ts
```

Inspect a denylist entry directly:

```bash
redis-cli -p 6390 --scan --pattern 'auth:jti:denylist:*'
redis-cli -p 6390 TTL auth:jti:denylist:<jti>   # positive, <= JWT_ACCESS_TTL_SECONDS
```

## How the SLA is actually tested

[`revocation.test.ts`](../../apps/api/tests/auth/revocation.test.ts) builds **two** `createApp`
instances sharing one database and one Redis, standing in for two pods behind a load balancer. Every
rejection assertion is made against the instance that did _not_ perform the revocation.

This matters. Asserting the denylist on the same instance that revoked would be consistent with a
purely in-process cache and would prove nothing about distributed enforcement, which is what the SLA
actually claims. The propagation case measures elapsed wall time and asserts it is under 5000 ms; the
real figure is one Redis round trip.

The suite also pins the properties that are easy to regress silently: TTL bounded by the token's own
lifetime, no entry written for an already-expired token, a cross-tenant target leaving the victim's
session live, and the audit row naming the administrator rather than the victim.

One trap worth recording, because a draft of this suite fell into it: `mintTestToken` defaults
`roles` to `[ORG_ADMIN]`. A test that omits them hands its subject administrative authority no matter
which user id the token names, and the 403 case "passed" a student through an admin route for
exactly that reason. Authorization is decided by the roles claim, so a permission test must state its
roles explicitly.

## Deliberately not done

**No user-level revocation epoch.** A `revoked-before` timestamp per user would make global logout
O(1) regardless of session count, without the `access_jti` column. It was rejected because it adds a
second Redis read to _every_ authenticated request — the hot path — and cannot express per-device
revocation at all, which is most of this ticket. The `jti` denylist already answers both questions
with one lookup that was already happening.

**No new `app.audit_action` enum values**, and **no `SESSION_REVOKE` permission** — see the audit and
authorization sections above.

**Sessions are soft-revoked, never deleted.** `revoked_at` is set and the row stays. The history is
evidence for a later investigation, and a delete would break the composite foreign key every
`refresh_tokens` row bound to a device holds. The same is true of `app.user_devices`, following the
rule `000017` set.

## Related

- [JWT verification architecture](./JWT_verification_architecture.md) — ST-070, the denylist read path
- [NFR-05 cross-tenant isolation](./NFR-05_cross_tenant_isolation.md) — ST-051, the isolation probe
- [Session model](../architecture/SAD_13_session_model.md) — ST-071, the rotation state machine
- [Audit logs data model](../database/audit-logs-data-model.md) — ST-046, partitioning and query rules
- [Role model](../database/role-model.md) and [ADR 0002](../adr/0002-fixed-roles-authorization.md) — the permission matrix
