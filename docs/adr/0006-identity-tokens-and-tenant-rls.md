# ADR-006: Identity tables, token storage, and tenant RLS

## Status

Accepted

## Context

ST-035 introduces the first tenant-scoped (school-owned) tables — the authentication and
identity model: `users`, `user_roles`, `oauth_identities`, `invitations`, `refresh_tokens`.
Every prior table (ST-033) is global and non-tenant, so several decisions are net-new: how
tenant isolation is enforced structurally, how invitation and refresh tokens are stored, how
OAuth identities are keyed, and what the `users` lifecycle and email-normalization rules are.
No SAD section, prior contract, or ADR covers tokens, sessions, OAuth, or RLS, so those
decisions are recorded here. Roles are already fixed by ADR-0002 (`@studafy/constants`).

## Decision

- **Tenant isolation is applied with the ST-034 helper, not per-table policies.** Each table
  is created owned by `studafy_admin`, is given a single-column `school_id` foreign key to
  `app.schools(id)`, and is passed to `app.apply_tenant_isolation('app', '<table>')`, which
  ENABLE + FORCE RLS and installs the canonical permissive `tenant_isolation` policy
  (`USING`/`WITH CHECK (school_id = current_setting('app.school_id')::uuid)`). Missing or
  invalid `app.school_id` fails closed.
- **Cross-tenant integrity is structural, not RLS-dependent.** `users` (and `refresh_tokens`)
  expose a `UNIQUE (id, school_id)` candidate key; child rows reference their parent with a
  composite `FOREIGN KEY (user_id, school_id) REFERENCES app.users(id, school_id)` (and the
  refresh-token rotation chain references `(id, school_id)` on itself). A child therefore
  cannot point at a parent in another school even if RLS were bypassed.
- **Tokens are stored hash-only as `bytea`.** `invitations.token_hash` and
  `refresh_tokens.token_hash` hold the 32-byte SHA-256/HMAC digest of a high-entropy random
  bearer token (`CHECK (octet_length(token_hash) = 32)`, `UNIQUE`). The raw token is generated
  and returned once by the application and never persisted, logged, or returned by an API.
  `bytea` was chosen over prefixed hex text (the migration-checksum convention) because a
  fixed-length binary digest needs no encoding/casing normalization and its length is checked
  directly. This is not password hashing — brute-force resistance comes from token entropy, so
  a keyed hash / SHA-256 is appropriate (pgcrypto is available but SQL-side hashing is not used).
- **OAuth identities are keyed globally on `(provider, subject)`.** An IdP subject identifies
  exactly one external account across the whole platform, so `UNIQUE (provider, subject)` is
  global (not tenant-scoped); the linked user is still constrained to one school by the
  composite foreign key. OAuth email is never treated as the stable identity.
- **`user_status` is an enum** `('invited','active','suspended','archived')` (default
  `invited`, `archived` terminal), mirroring `app.school_status`; transitions are
  application-enforced.
- **Email normalization policy:** `normalized_email = lower(btrim(email))`, computed by the
  application. The database enforces only the canonical shape (lowercase, trimmed, non-empty,
  bounded). Uniqueness is tenant-scoped: `UNIQUE (school_id, normalized_email)`, so the same
  person may exist in more than one school.
- **Time-based expiry is evaluated at use, never in a constraint.** Lifecycle constraints only
  compare stored columns (`expires_at > created_at`, `revoked_at >= issued_at`, …); no `now()`
  appears in a `CHECK` or index predicate. Whether an invitation/token is currently expired is
  decided inside the authenticating transaction.

## Alternatives considered

- **Rely on RLS alone for cross-tenant integrity** — simpler schema, but a single missing GUC
  or a future `BYPASSRLS` mistake would allow a child row to reference another tenant's user.
  Rejected: defense in depth via composite foreign keys costs one extra unique index per parent
  and removes the failure mode entirely.
- **Prefixed hex text for token hashes** (mirroring `schema_migrations.checksum`) — readable in
  `psql`, but adds casing/format normalization and a regex check for no security benefit over a
  length-checked `bytea`. Rejected.
- **Tenant-scoped `(school_id, provider, subject)` OAuth uniqueness** — would let the same IdP
  subject map to different users per school. Rejected: it contradicts how IdP subjects work and
  the ST-035 acceptance criterion, and it would enable account-confusion across tenants.
- **A single generic `tokens` table** for invitations and refresh tokens — rejected: their
  audience, lifecycle, revocation semantics, and retention differ, and a shared table would
  weaken each set of constraints to the union of both.
- **`now()`-based partial unique / check constraints** (e.g. "one non-expired invitation") —
  rejected: such predicates are not immutable and are invalid in indexes/checks. The active
  invitation rule uses only `revoked_at IS NULL AND consumed_at IS NULL`.

## Consequences

- The identity tables are the first consumers of the ST-034 RLS helper; the helper's
  preconditions (schema `app`, admin-owned, `school_id` NOT NULL + single-column FK) are part
  of the migration's structure.
- Each parent table carries an extra `UNIQUE (id, school_id)` index purely to anchor composite
  foreign keys — an accepted write-cost for structural tenant safety.
- Child-side composite foreign keys used by inviter lookups and refresh-token rotation traversal
  have matching `school_id`-leading indexes. Their write cost is accepted to avoid tenant-wide
  scans during parent update/delete checks and token-chain operations.
- Callers must combine the RLS tenant boundary with an application-layer `PERMISSIONS` check
  (ADR-0002): RLS answers "which school's rows", authorization answers "may this role do this".
- The OAuth-callback lookup by `(provider, subject)` runs in a flow that must establish the
  correct `app.school_id`; wiring that flow is application work outside this migration.
