# ADR-008: Tenancy model — one school per row, one GUC per transaction

## Status

Accepted

## Context

Studafy is a multi-school SaaS: nearly everything it stores is owned by exactly one school, and a
school must never observe another school's rows. The first application migrations (`000004`/`000005`) are
all global — reference data plus `app.schools` as the tenant anchor — and the first tenant-scoped
tables (`users`, `refresh_tokens`, etc., ST-034/ST-035) were introduced on top of that anchor. Two concerns had to be settled for the whole repository rather
than per feature: how tenancy is identified structurally (which column says "whose row is this"),
and how it is enforced at runtime (what a query is scoped to). NFR-05
([`docs/security/NFR-05_cross_tenant_isolation.md`](../security/NFR-05_cross_tenant_isolation.md))
treats cross-tenant isolation as a hard requirement, so the model must be uniform, not reinvented
per migration.

## Decision

- **Tenancy is a column on the row, not a physical boundary.** `app.schools` (000004) is the tenant
  anchor. Every tenant-owned table carries a `school_id uuid NOT NULL` with a single-column foreign
  key to `app.schools(id)` using `ON UPDATE RESTRICT ON DELETE RESTRICT`. There is no schema-per-tenant
  or database-per-tenant arrangement anywhere in the deployment; all tenants share one physical
  database and `school_id` picks the rows.
- **Every table is classified as exactly one of two kinds, and there is no third.**
  A tenant table carries `school_id` and is isolated (ADR-0015). A global table carries no
  `school_id` at all — `schools`, `plans`, `plan_prices`, `countries`, `currencies`,
  `platform_settings` are the canonical set (see
  [`docs/database/global-tables.md`](../database/global-tables.md) and
  [`docs/api/global-data-erd.md`](../api/global-data-erd.md)). An "approved global table that
  unexpectedly contains school_id" is rejected by the RLS-coverage linter as
  `GLOBAL_SCOPE_DRIFT` (`db/policies/rls-coverage.ts`), the same rule 000029's header records as the
  reason a global refresh-token directory was never built.
- **Cross-tenant referential integrity is structural, not RLS-dependent.** Child tables that
  reference a tenant-owned parent use composite foreign keys `(parent_id, school_id) REFERENCES
parent(id, school_id)`, so a child can never point at a parent in another school even where RLS
  does not run. Each parent pays one extra `UNIQUE (id, school_id)` index to anchor those keys,
  first applied to `app.users`/`app.refresh_tokens` in 000007 and ADR-0006.
- **A person's identity is per-school, not global.** `users` uniqueness is `(school_id,
normalized_email)`, so the same human may exist in more than one school as far as the platform is
  concerned; OAuth subjects are the one global identity key (`(provider, subject)`, ADR-0006).
- **A tenant is rooted at a row in `app.schools` with a lifecycle.** `app.school_status` is
  `('pending','active','suspended','archived')`; transitions are application-enforced, `archived` is
  terminal. See [`docs/architecture/tenant-lifecycle-state-table.md`](../architecture/tenant-lifecycle-state-table.md)
  and the lifecycle middleware (`apps/api/src/middleware/tenant-lifecycle.ts`) that reads the
  subscription status at request time.
- **Runtime tenancy is a transaction-local GUC, armed before any statement runs.** `withTenantTx`
  (`apps/api/src/db/tenant-tx.ts`) sets `app.school_id` (plus `app.user_id` and `app.request_id`
  where present) via `set_config(..., true)` immediately after BEGIN, so the value is scoped to the
  transaction and evaporates at COMMIT — safe under PgBouncer transaction pooling. Work with no known
  tenant up front (a payment-provider webhook) opens with `withSystemTx` and arms tenancy later with
  `setTenantScope`, exactly once the tenant is resolved.
- **Centralized tenant management stays in `app.schools`.** Provisioning and restore are
  documented runbook operations, not schema events
  ([`docs/runbooks/tenant-provisioning-checklist.md`](../runbooks/tenant-provisioning-checklist.md),
  [`docs/runbooks/tenant-restore.md`](../runbooks/tenant-restore.md)).

## Alternatives considered

- **Schema per tenant** (a Postgres schema per school, same tables each) — would multiply every
  migration across schemas, destroy shared indexing/query plans for the cross-tenant legal/reporting
  needs, and still not solve RLS on top. Rejected at the first tenant migration: one schema, one set
  of objects, column-carried tenancy is the only shape that keeps NFR-05 provable with one helper.
- **Database per tenant** — clean isolation but operationally untenable at platform scale (one
  instance per school, backups/PITR/connection pools per tenant), and it removes the single
  cross-tenant global view the platform needs (plans, platform settings, an admin's view).
- **One global `tenants` directory keyed by an opaque locator in every request.** Rejected by the
  000029 header as "the worst of both worlds": a table in this schema either carries `school_id` and
  is tenant-isolated, or carries none and is global; a directory whose job is to return a `school_id`
  is the second category unsatisfiable by the first.
- **RLS as the only cross-tenant guarantee, with single-column FKs.** Simpler schema, but a missing
  GUC or a future `BYPASSRLS` mistake would let a child row reference another tenant's parent.
  Composite foreign keys (ADR-0006) remove that failure mode at the cost of one index per parent —
  accepted.

## Consequences

- Every tenant query's first act is arming `app.school_id`; a query under an unset GUC raises
  `42704` rather than matching nothing, so forgetting to arm is a loud error, never an empty (and
  dangerously quiet) result.
- The second argument to every migration creating a tenant table is `school_id` plus the FK and
  the `UNIQUE (id, school_id)` anchor — the schema for all tenant tables is now uniform and
  `app.apply_tenant_isolation` (ADR-0015) can enforce the preconditions mechanically.
- Write cost: one extra unique index per tenant parent and a school-leading key per child. Accepted
  once, for every tenant table.
- Adding a new tenant table is a decision-free act (follow `material_chunks` or `users` for the
  shape); changing to a different tenancy model (e.g. "one `org_id`" or "user can belong to several
  schools") is a schema-wide change requiring a new ADR, not a per-feature tweak.
- Tenant-level operations (restore, rollover, suspension) are documented runbook procedures that
  touch `app.schools` state and per-tenant data, not infrastructure.

## Review

Reviewed by `baderalhindi` on 2026-09-11.
