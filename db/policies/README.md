# Tenant Row-Level Security policy authoring

Studafy isolates every school-owned PostgreSQL row with the canonical `school_id` column, the
transaction-local `app.school_id` setting, and one policy named `tenant_isolation`. Global platform
tables are deliberately outside this model.

## Classify the table first

The global tables are `app.schools`, `app.plans`, `app.plan_prices`, `app.countries`,
`app.currencies`, and `app.platform_settings`. They contain no `school_id`, receive no tenant policy
or tenant index, and are rejected by the helper.

A tenant table must be in `app`, owned by `studafy_admin`, and use a non-null UUID `school_id` with a
single-column foreign key to `app.schools(id)`. Use explicit `ON UPDATE` and `ON DELETE` actions;
default to `RESTRICT` while school deletion is a controlled lifecycle operation. The runtime role
`studafy_app` receives only the required table DML grants and must remain `NOBYPASSRLS`.

## Install the policy

Create the table, constraints, and justified indexes in an ordered migration, then call:

```sql
SELECT app.apply_tenant_isolation('app', 'student_profiles');
```

The administrative migration connection must first use `SET ROLE studafy_admin`. The helper is
`SECURITY INVOKER`; it cannot elevate its caller. `PUBLIC` and `studafy_app` cannot execute it.
It accepts identifiers separately, resolves them through PostgreSQL catalogs, and quotes dynamic
DDL with `%I`. It never creates columns, grants DML, changes ownership, or creates indexes.

The helper enables and forces RLS and creates one permissive `FOR ALL TO PUBLIC` policy:

```sql
USING (school_id = current_setting('app.school_id')::uuid)
WITH CHECK (school_id = current_setting('app.school_id')::uuid)
```

`USING` limits rows visible to `SELECT`, eligible for `UPDATE`, and eligible for `DELETE`.
`WITH CHECK` rejects an `INSERT` or resulting `UPDATE` row outside the current school. Both are
required: omitting `WITH CHECK` would allow writes to cross the tenant boundary.

The policy is permissive because PostgreSQL requires a permissive policy to admit rows. It is the
only permitted permissive policy on a canonical tenant table; permissive policies combine with
`OR` and could otherwise broaden access. Additional restrictive policies combine with `AND` and
are preserved. An incompatible existing `tenant_isolation` policy fails instead of being replaced.

## Fail-closed tenant context

The policy intentionally calls `current_setting('app.school_id')` without `missing_ok`. A missing
setting raises an error. Empty, whitespace, or malformed values fail the UUID cast. A valid but
different UUID sees no rows, and a matching but nonexistent school UUID fails foreign-key-backed
writes. There is no default tenant, `OR` fallback, or text cast on the indexed column.

Every pooled runtime operation on tenant data must use one transaction:

```sql
BEGIN;
SELECT set_config('app.school_id', '00000000-0000-4000-8000-000000000001', true);
-- tenant queries
COMMIT;
```

`SET LOCAL app.school_id = '...'` is equivalent. The API must authenticate the principal and verify
its permitted school before setting the value; a client-provided school ID is never authoritative.
Transaction-local state clears at commit or rollback, matching PgBouncer transaction pooling.
Session-level `SET` can leak tenant identity to the next request and is prohibited.

## Normalization and relational integrity

- Keep values atomic (1NF); never hide tenant identity in JSONB, arrays, lists, or composite text.
- Make every non-key attribute depend on the whole key (2NF), using junction tables for many-to-many
  relationships.
- Keep school metadata and global country, currency, plan, and setting facts in their source tables
  (3NF); tenant rows reference them rather than copying them.
- Use tenant-scoped candidate keys such as `UNIQUE (school_id, code)` when values may repeat across
  schools. RLS does not replace uniqueness or foreign keys.
- For relationships between tenant tables, prevent cross-school references with a parent
  `UNIQUE (id, school_id)` and child `FOREIGN KEY (parent_id, school_id)` when appropriate. RLS alone
  cannot prevent inconsistent cross-tenant references.

Any deliberate denormalization must record its source of truth, consistency and update strategies,
performance evidence, and tenant-isolation consequences.

## Indexing

RLS makes `school_id` a universal predicate. Most tenant query indexes therefore begin with it:
`(school_id, status)`, `(school_id, created_at DESC, id DESC)`, or another order matching a real
filter and sort. Cast the setting to UUID, as the policy does; never wrap `school_id` in a function.

PostgreSQL does not automatically index referencing foreign keys. Review the school FK for tenant
listing, joins, and parent checks. A tenant-scoped unique constraint already provides a
school-leading index, so do not add a redundant plain index. Avoid status-only, boolean-only,
speculative partial, and duplicate-prefix indexes. Record the query pattern, column order,
uniqueness, RLS interaction, write cost, and `EXPLAIN` evidence for every added index.

## Verification and troubleshooting

Inspect `pg_class.relrowsecurity` and `relforcerowsecurity`, and use `pg_policy` plus
`pg_get_expr()` to verify `tenant_isolation`. Test every new table as `studafy_app` with two schools,
covering reads, inserts, updates, deletes, tenant-key mutation, missing/invalid context, and context
reset after commit and rollback.

Helper errors are deliberate: fix the table owner, column type/nullability, school foreign key, or
conflicting policy in a new forward migration. Do not disable RLS, grant `BYPASSRLS`, make the app
role an owner, suppress context errors, or edit an already-applied migration.
