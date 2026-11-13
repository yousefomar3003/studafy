# ADR-015: RLS conventions — one helper, fail-closed, every tenant table

## Status

Accepted

## Context

NFR-05 ([`docs/security/NFR-05_cross_tenant_isolation.md`](../security/NFR-05_cross_tenant_isolation.md))
makes cross-tenant isolation a hard, _provable_ requirement. When tenant tables were first
introduced (ST-034/ST-035), the options were a per-table policy written by hand — which drifts and
is only as strong as the newest migration — or a single mechanical rule applied everywhere. The
decision is the latter, and it is deliberately uniform: RLS is the row filter, authorization (may
this role do this) is a separate application-layer concern (ADR-0002).

## Decision

- **Two roles, one helper, no exceptions.** The schema runs on exactly two database roles —
  `studafy_admin` (owns all objects, runs migrations and controlled maintenance) and `studafy_app`
  (the application's runtime role). Every tenant table is created by `studafy_admin` and then passed
  to **`app.apply_tenant_isolation('app', '<table>')`** (`000006`), which is the only way tenant RLS
  is installed.
- **The helper enforces the preconditions mechanically.** It refuses to run unless the table is in
  schema `app`, owned by `studafy_admin`, and carries a `NOT NULL school_id uuid` with a
  single-column FK to `app.schools(id)`. It refuses to touch the known global tables. It refuses a
  table that already has any other _permissive_ policy, because a permissive policy can only widen
  tenant access. It then `ENABLE`+`FORCE ROW LEVEL SECURITY` and installs the canonical policy:

  ```sql
  CREATE POLICY tenant_isolation ON app.<table> AS PERMISSIVE FOR ALL TO PUBLIC
    USING      (school_id = current_setting('app.school_id')::uuid)
    WITH CHECK (school_id = current_setting('app.school_id')::uuid);
  ```

  If a policy already exists, the helper re-asserts this exact shape rather than overwriting it.

- **`FORCE` is load-bearing.** With `FORCE ROW LEVEL SECURITY`, the owning role (`studafy_admin`)
  is subject to the policy too, and this schema deliberately has **no `BYPASSRLS` role anywhere** —
  `packages/db/tests/rls.test.ts` asserts both roles stay `NOBYPASSRLS`, and 000002 refuses to
  proceed if either ever carries the attribute. This is what makes the "security definer reads a
  protected table" attack dead on arrival (000029's header documents the failed attempt).
- **Fail closed by construction.** Policies read `current_setting('app.school_id')` with no
  `missing_ok`, so an unset GUC _raises_ (`42704`) rather than matching nothing. A caller that
  forgets to arm tenancy (ADR-0008) gets an error, never a silently empty result set — the
  "closed and loud" default.
- **A second, restrictive layer for owner-scoped data.** Tenant isolation alone means any
  authenticated session in a school can read that school's rows. For owner-scoped tables
  (`refresh_tokens`, `user_devices`), a **restrictive** policy scoped `TO studafy_app` adds a per-
  user fence that ANDs with `tenant_isolation` (e.g. `refresh_tokens_owner ... USING (user_id =
app.current_user_id())`, 000029). Restrictive policies can only narrow, so they are the only
  sanctioned second layer.
- **Global tables are the documented exception with their own rules.** A global table carries no
  `school_id` (ADR-0008). The canonical six are RLS-free and SELECT-only for `studafy_app`
  (000004). `app.billing_events` is the one global table that is itself sensitive: it is
  ENABLE+FORCE RLS'd with a single policy scoped `TO studafy_admin` and `studafy_app` privileges
  revoked (000016) — processed only under `withSystemTx`'s controlled `studafy_admin` elevation
  (ADR-0013).
- **The invariant is linted, not assumed.** `db/policies/rls-coverage.ts` (run via
  `bun run db:test:rls-coverage`) classifies every table tenant/global, rejects `GLOBAL_SCOPE_DRIFT`
  (a "global" table carrying `school_id`), and reports per-table policy shape. The runtime tests
  exercise the policies directly (`packages/db/tests/rls.test.ts`, `cross-tenant.test.ts`).

## Alternatives considered

- **Per-table hand-written policies** — readable, but each table gets a bespoke policy that can
  drift from the canonical shape, and drift is silent. Rejected: the helper's precondition checks
  make the rule structural instead of remembered.
- **`SECURITY DEFINER` functions as the way to read protected tables** — recorded dead: `FORCE`
  RLS applies the policy to the function's owner too, and there is no BYPASSRLS role, so the
  function is filtered by the same unset GUC and fails closed. That is the isolation design working,
  not a bug to route around.
- **Application-layer filtering only, no RLS** — bypassable by any direct/SQL path and unprovable
  against NFR-05. Rejected outright.
- **A per-role policy per table** (one policy per role's scope) — explosion of policy objects and a
  drift surface; rejected in favour of the two-layer AND where an owner fence is needed.

## Consequences

- Every tenant query must establish `app.school_id` (`withTenantTx`/`setTenantScope`) or fail; the
  failure is loud by design (ADR-0008).
- Tenant RLS is uniform and cheap to review: a table's isolation is either `apply_tenant_isolation`
  plus optional restrictive owner policy, or it is an approved global table — nothing in between.
- There is no back-door role: `studafy_admin`, migrations, and even system work run against the same
  policies (system work elevates via `SET LOCAL ROLE studafy_admin` in `withSystemTx` for the few
  global-sensitive paths and arms the GUC once the tenant is known).
- Structured maintenance (support access, global writes) is a controlled procedure, not a role
  change — the two-role model (see `docs/database/role-model.md`) is what keeps NFR-05 inspectable.

## Review

Reviewed by `baderalhindi` on 2026-09-11.
