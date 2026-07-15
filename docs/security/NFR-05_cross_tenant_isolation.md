# NFR-05 cross-tenant isolation

The ST-051 probe is an executable attack on Studafy's school boundary. It creates a fresh migrated
database, inserts exactly two schools, and exercises restricted API transactions, physical
constraints, query plans, and deliberately contaminated pooled connections. The stable GitHub
Actions status is `CI / cross-tenant-security`; branch protection must require that status.

## Run locally

Start the repository's disposable PostgreSQL service and provide its administrative database URL:

```bash
POSTGRES_PASSWORD=studafy_local docker compose -f db/compose.yml up -d --wait
TEST_DATABASE_URL='postgresql://studafy_test:studafy_local@127.0.0.1:54329/postgres?sslmode=disable' \
  bun run test:security
docker compose -f db/compose.yml down
```

The suite reports cold database creation, migration, and fixture time separately. Its `<500 ms`
gate begins only after migrations, seeding, `ANALYZE`, and one complete warm-up probe. This keeps the
security budget focused on PostgreSQL and pool behavior rather than image pulls or process startup.

## GUC leakage attack and mitigation

PgBouncer transaction mode does not run `DISCARD ALL` between transactions. A session-level
`SET app.school_id = ...` therefore survives and can be observed by the next logical request using
that backend. The test reserves all four physical Postgres.js connections, contaminates each with
School A, releases them, and sends 32 concurrent School B requests through
`withTenantTransaction`. Every request must reuse a contaminated backend while observing School B's
GUC and only School B's rows.

All school-scoped API work must use `withTenantTransaction(database, context, callback)`. The helper
assumes `studafy_app`, sets `app.school_id` and optional `app.user_id` with transaction-local
`set_config`, and exposes the connection only after those statements succeed. Both commit and
rollback clear the local override. Do not issue tenant queries directly through the pool and never
replace the local setting with session-level `SET`.

## Relational boundary

RLS controls visibility, but it is not a foreign key. Every relationship between tenant tables
contains `school_id` on both sides of its composite foreign key. The normalization probe runs through
the administrative connection and attempts to attach a School A attendance record to School B's
session. PostgreSQL must return `23503`, proving the physical relationship remains safe when RLS is
bypassed.

Tenant ownership is also immutable. Migration `000025` installs a `BEFORE UPDATE OF school_id`
trigger on every tenant root table and updates the canonical isolation helper so future tables receive
it. The trigger returns `42501` even for a superuser. The catalog audit reports
`TENANT_OWNERSHIP_IMMUTABLE` if a root, partitioned parent, or partition leaf loses this protection.

## Index execution verification

The probe discovers every ordinary or partitioned `app` relation containing `school_id`. As
`studafy_app`, it parses `EXPLAIN (FORMAT JSON)` recursively. With sequential scans disabled, every
relation must expose an Index Scan, Index Only Scan, or Bitmap Index Scan and no residual Seq Scan;
this proves a usable school-leading B-tree exists behind RLS. After `ANALYZE`, relations estimated at
32 or more rows are checked again with normal planner settings and may not fall back to a Seq Scan.

The ST-050 catalog audit remains the structural source of truth for the leading `school_id` key,
canonical policy, composite foreign keys, forced RLS, and tenant-ownership trigger.

## Failure response

1. Preserve the JSON diagnostic containing operation, relation, primary key, expected/observed
   tenant, backend PID, row count, SQLSTATE, and plan.
2. Reproduce against a freshly migrated disposable database with `bun run test:security`.
3. For a GUC leak, find the path that bypassed `withTenantTransaction`; move every tenant statement
   behind the helper and verify both commit and rollback.
4. For `23503` failures in legitimate writes, compare every child/parent `school_id`; never weaken the
   composite key or replace it with an id-only reference.
5. For `TENANT_OWNERSHIP_IMMUTABLE`, restore the canonical trigger using a forward migration and
   `app.apply_tenant_ownership_immutability`. Never edit an applied migration.
6. For plan failures, inspect the emitted JSON and add or repair a justified school-leading B-tree.
   Do not suppress the assertion or disable RLS.
7. Rerun migration validation, RLS coverage, the security probe, database tests, lint, type checking,
   and formatting before review.
