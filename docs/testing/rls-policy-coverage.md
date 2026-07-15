# RLS policy coverage audit

ST-050 provides a read-only PostgreSQL catalog audit for every application table, partitioned parent,
and partition leaf in schema `app`. It runs in CI after all migrations and can inspect a local or
environment database without changing it.

## Running the audit

```bash
DATABASE_URL='postgresql://...' DATABASE_SSL_MODE=require bun run db:test:rls-coverage
```

Disposable local PostgreSQL uses `DATABASE_SSL_MODE=disable`; deployed databases must retain the
repository's TLS requirements. Exit codes are `0` for compliance, `1` for a compliance or performance
failure, and `2` for invalid invocation, configuration, connection, or catalog-query failure.

The output identifies the rule, relation and column, observed catalog state, exact remediation, and
diagnostic SQL. Missing-index failures also execute and print an `EXPLAIN (COSTS OFF)` hazard. For a
complete state dump, run `db/policies/rls-coverage-diagnostics.sql` with `psql`.

## Classification and RLS rules

Every `app` table must either contain `school_id` or appear in the reviewed global allowlist:
`countries`, `currencies`, `schools`, `plans`, `plan_prices`, `platform_settings`, and
`billing_events`. `public.schema_migrations` is outside the application schema and therefore outside
this audit. A new global table fails until its scope is documented and reviewed.

Every tenant relation must have:

- a non-null UUID `school_id` matching and directly referencing `app.schools(id)` through a validated
  single-column foreign key;
- `pg_class.relrowsecurity` and `relforcerowsecurity` enabled;
- the exact permissive `FOR ALL TO PUBLIC` `tenant_isolation` policy using and checking
  `school_id = current_setting('app.school_id')::uuid`;
- no other permissive policy, because permissive policies combine with `OR` (additional restrictive
  policies are allowed); and
- a valid, ready B-tree whose leftmost key is `school_id`.

HNSW, GIN, and GiST indexes do not satisfy the relational tenant path. A documented partial B-tree
does qualify when its predicate is the relation's normal query boundary. A plain, non-unique,
non-partial single-column `school_id` index fails as redundant when another composite B-tree already
covers that prefix. Unique, constraint-backed, and semantic partial indexes are preserved.

## Normalization and constraints

For every foreign key from one tenant table to another, `school_id` must occur on both sides at the
same key position and the constraint must be validated. This prevents orphaned or cross-school
relationships even for superusers and `BYPASSRLS` roles.

Array, JSON, and JSONB columns fail by default because catalog metadata cannot prove that they are
not hiding relationships. The exact reviewed payload exceptions are:

- `audit_logs.old_values` and `audit_logs.new_values`;
- `billing_events.payload`;
- `fee_schedule_cache.erpnext_payload`, `invoice_cache.erpnext_payload`, and
  `payment_cache.erpnext_payload`;
- `finance_sync_outbox.payload`; and
- `notifications.metadata`.

These hold polymorphic audit state or external/flexible provider payloads. Tenant identity and
relational routing remain normal constrained columns. Adding another exception requires data-model
documentation and an explicit audit allowlist change.

## Performance methodology

The client first establishes its connection and warms the exact prepared, read-only catalog query.
It then measures the complete query in one round-trip. A measured execution of 100 ms or more is a
`PERFORMANCE_BUDGET` violation. The integration test repeats the full audit twenty times and asserts
the p95 remains below 100 ms.

## Remediation runbook

1. Reproduce with `bun run db:test:rls-coverage` against a fully migrated disposable database.
2. Run the diagnostic SQL helper and inspect the reported policy, index, or constraint definitions.
3. Add a new forward migration; never edit a migration already applied to a shared environment.
4. For RLS failures, use `app.apply_tenant_isolation('app', '<table>')` only after its owner, school
   column, school foreign key, and indexes meet the helper contract.
5. For missing indexes, verify the named tenant query and use `CREATE INDEX CONCURRENTLY` in an
   idempotent non-transactional migration when the live table may be large.
6. Replace tenant-to-tenant scalar foreign keys with composite keys on the parent's tenant candidate
   key. Normalize arrays or JSON that represent stable relations into child/junction tables.
7. Rerun migration validation, database tests, the coverage command, lint, type checking, and format
   checks before review.

Do not resolve a failure by disabling/weakening RLS, granting `BYPASSRLS`, making the app role an
owner, adding an undocumented global/flexible-column exemption, or suppressing the CI exit code.
