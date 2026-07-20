# Invitation verification security model

`GET /api/auth/invitations/{token}/verify` is the public, read-only gate between receiving an
invitation and starting account provisioning. The path token is a 256-bit lowercase hexadecimal
bearer credential. Only its SHA-256 digest is stored in `app.invitations.token_hash`.

## Response matrix

Checks are deterministic and stop at the first state in this table.

| Order | Condition                                           | HTTP | Problem `code` / success body                     |
| ----- | --------------------------------------------------- | ---- | ------------------------------------------------- |
| 1     | `expires_at <= now()`                               | 409  | `EXPIRED`                                         |
| 2     | `revoked_at IS NOT NULL`                            | 409  | `REVOKED`                                         |
| 3     | `consumed_at IS NOT NULL`                           | 409  | `CONSUMED`                                        |
| 4     | School is `pending`, `suspended`, or `archived`     | 409  | `SCHOOL_SUSPENDED`                                |
| 5     | School is `active` and no earlier condition matched | 200  | `{ "state": "valid", "emailHint", "schoolName" }` |

Malformed and well-formed nonexistent tokens both return `400` with `INVITATION_INVALID`. Every
failure uses `application/problem+json`, a generic detail, and the server-generated `request_id`.
Only a valid response exposes tenant information. It contains no invitation, school, or user ID.

The normalized email local part is rendered as its first character, three literal asterisks, and
its final character; the lowercased domain is preserved. For example, `john.doe@example.com`
becomes `j***e@example.com`. A malformed stored value becomes `***` rather than being reflected.

## Forced-RLS lookup boundary

Migration `000031` adds `app.lookup_invitation_for_verification(bytea)`. It is a
`SECURITY DEFINER` function owned by `studafy_admin`; `PUBLIC` has no access and `studafy_app` has
only `EXECUTE`. The function keeps forced RLS enabled, sets a non-matching tenant and the presented
digest in transaction-local GUCs, and relies on a `SELECT`-only, admin-only policy constrained to
that exact digest. Ordinary `studafy_app` reads cannot use the policy.

The indexed lookup always returns one row. A miss receives fixed dummy hash, email, timestamp,
school name, and school status values. Application code always performs SHA-256 hashing,
`timingSafeEqual`, masking, and lifecycle evaluation before trusting the separate `found` flag.
Transaction-local GUCs are cleared before a pooled connection can be reused.

The existing `uq_invitations_token_hash` constraint is the unique B-tree lookup index, and
`ck_invitations_token_hash` fixes stored digests at 32 bytes. Raw tokens are never persisted.

## Logging and throttling

The request context, request logger, CORS/CSRF security-event paths, and not-found problem response
all pass through the shared sensitive-path sanitizer. The token segment is represented as
`[REDACTED]`; service errors and database parameters contain only the SHA-256 digest. Raw tokens
must not be added to logger, audit, event, or exception fields.

The route is explicitly public in the JWT boundary and explicitly classified as `auth` by the
Redis token-bucket limiter. Auth buckets are IP-scoped, allow a burst of 10 requests, refill at
0.17 requests per second, and use a 60-second window. The eleventh request without refill returns
`429` with `Retry-After` and the standard problem envelope.

## Timing verification

The CI benchmark uses a single-connection disposable PostgreSQL database, warms both arms 200
times, then randomly interleaves 1,000 valid and 1,000 missing digest resolutions. It gates the
absolute difference between distributions at less than 1 ms for the median and less than 2 ms for
p95. These bounds operationalize “no measurable variation” without asserting impossible exact
nanosecond equality on shared hardware. The benchmark measures token resolution, not response JSON:
valid and invalid responses intentionally have different documented shapes.
