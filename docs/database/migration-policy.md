# SQL migration policy

Studafy's PostgreSQL 16 schema is defined by ordered SQL files in [`db/migrations`](../../db/migrations).
SQL is the source of truth: do not generate schema changes from an ORM or application startup.

The database role and grant model that migrations run under — `studafy_admin` (owner/migrations) and
`studafy_app` (runtime) — is documented in [role-model.md](./role-model.md). Object-creating
migrations must `SET ROLE studafy_admin` so ownership and default privileges apply.

## Tool and layout

The repository-native `@studafy/db` CLI uses Bun 1.3.14 and the existing `postgres` 3.4.9 driver.
dbmate was rejected because its history table does not store migration checksums. Goose would add
a Go binary and still require repository-specific checksum behavior. Flyway provides checksums but
adds a separate Java/tool lifecycle. The small runner keeps the required behavior explicit without
adding another runtime or migration abstraction.

```text
db/migrations/                         authoritative SQL
packages/db/src/                       CLI and runner
packages/db/tests/                     unit and disposable-Postgres tests
infra/docker/migrations.Dockerfile     deployment artifact
```

Migration names match `000001_canonical_name.sql`: exactly six ordered digits, an underscore, and
a lowercase snake-case name. Versions and names are unique. Add the next numeric version; never
reuse a gap, introduce a version below the greatest applied version, or mix timestamp versions with
the sequential convention.

The first migration, `000001_initial_noop.sql`, deliberately creates no application table. It
proves discovery, checksumming, transactional execution, history recording, and idempotency.

## Commands and configuration

Run independently from application startup:

```bash
bun run db:migrate
bun run db:migrate:status
bun run db:migrate:validate
bun run db:migrate:pending
```

`DATABASE_URL` is the local/CI interface. ECS uses the existing `DATABASE_HOST`, `DATABASE_PORT`,
`DATABASE_NAME`, `DATABASE_USER`, and `DATABASE_PASSWORD` fields injected from Secrets Manager.
Do not mix the URL and discrete forms. The CLI never prints either form.

`DATABASE_SSL_MODE` accepts `disable`, `require`, `verify-ca`, or `verify-full` and defaults to
`require`. The verified modes require `DATABASE_CA_CERT`. `disable` is for disposable local/CI
PostgreSQL only. Production migrations connect directly to RDS on port 5432, not to transaction-mode
PgBouncer on 6432.

For local PostgreSQL 16 verification, start Docker Desktop and use an operator-chosen disposable
password; the database uses tmpfs and is destroyed with the container:

```bash
POSTGRES_PASSWORD='<local-only-password>' docker compose -f db/compose.yml up -d --wait
TEST_DATABASE_URL='postgresql://studafy_test:<local-only-password>@127.0.0.1:54329/postgres?sslmode=disable' \
  bun test packages/db/tests/integration.test.ts
docker compose -f db/compose.yml down
```

PowerShell uses the same values through `$env:POSTGRES_PASSWORD` and `$env:TEST_DATABASE_URL`
before running the corresponding `docker compose` and `bun test` commands.

Do not commit `.env` files or real URLs. The CI password in the workflow belongs only to its
ephemeral service container and is not a credential for any external system.

## History, checksums, and locking

The runner creates `public.schema_migrations` under the advisory lock:

| Column                  | Type          | Purpose                                       |
| ----------------------- | ------------- | --------------------------------------------- |
| `version`               | `bigint`      | Ordered primary key                           |
| `name`                  | `text`        | Canonical unique name                         |
| `checksum`              | `text`        | `sha256:` plus 64 lowercase hexadecimal chars |
| `applied_at`            | `timestamptz` | Database application timestamp                |
| `execution_duration_ms` | `bigint`      | Measured execution duration                   |
| `tool_version`          | `text`        | Runner version                                |

SHA-256 is calculated over the exact UTF-8 file bytes. `.gitattributes` fixes SQL to LF so Windows
and Linux calculate the same value. Before applying pending SQL, the runner verifies every applied
version, name, file, and checksum. Missing, renamed, reordered, or edited applied migrations stop
execution. Stored checksums are never repaired automatically.

Every command reserves one physical PostgreSQL connection and attempts session advisory lock
`6004517954832980272`. Lock contention fails immediately with `MigrationLockError`; callers may
retry the whole command. The lock is released in `finally`, the reserved connection is released,
and the client closes. PostgreSQL releases it automatically if the session dies.

## Transactions and recovery

Migrations are transactional by default. SQL and its history insert commit together; any error
rolls both back. The CLI returns non-zero and identifies the failed file.

Statements prohibited in a transaction, notably `CREATE INDEX CONCURRENTLY`, require this exact
first nonblank line:

```sql
-- studafy:migration transaction=off
CREATE INDEX CONCURRENTLY idx_example_lookup ON example (lookup_key);
```

Non-transactional migrations are exceptional and must be idempotent and roll-forward safe, using
guards such as `IF NOT EXISTS` where PostgreSQL supports them. The history row is written only after
SQL succeeds. If a process dies after DDL succeeds but before history is recorded, inspect the
database, make the SQL safe to re-execute without editing an already-applied file, and rerun. Never
insert or alter a history row manually to conceal partial work.

There are no automatic down migrations. Schema rollback is often destructive and can be
incompatible with still-running application versions. Recover with application rollback when the
expanded schema remains compatible, or add a new corrective forward migration.

## Expand, migrate, contract

1. **Expand:** add backward-compatible nullable columns, tables, indexes, or unvalidated
   constraints. Deploy code that can use both old and new shapes.
2. **Migrate:** backfill in bounded, restartable batches. Avoid loading whole tables, long
   transactions, or unbounded locks; track progress and validate the result.
3. **Contract:** only after every deployed version ignores the old shape, remove obsolete columns,
   indexes, or compatibility code and tighten constraints.

Do not combine expansion and destructive contraction during a rolling deployment. For large
tables, add foreign keys or checks with `NOT VALID` and validate separately when appropriate.
Set conservative lock timeouts inside risky migrations, observe production locks, and prefer
roll-forward recovery.

## Normalization standard

- Keep columns atomic (1NF); no comma-separated lists or repeating groups.
- For composite keys, every non-key value must depend on the whole key (2NF). Use junction tables
  for many-to-many relationships.
- Non-key values must depend only on the key (3NF); separate reusable entities and avoid derived or
  duplicated facts without evidence.
- Use foreign keys with explicit update/delete behavior and preserve natural uniqueness with named
  unique constraints even when a surrogate primary key is appropriate.
- Avoid polymorphic foreign keys, generic key-value core tables, and JSONB for stable relational
  structure. JSONB is for genuinely flexible or external payloads.
- Do not over-normalize immutable enumerations. Any deliberate denormalization must document its
  reason, source of truth, consistency/update strategy, and measured or expected query need.

No application schema exists in this task, so no business normalization changes are invented.

## Indexing standard

- Every index needs a named query, integrity, join, filter, sort, or pagination purpose.
- Primary and natural unique constraints provide their own indexes; do not duplicate them.
- Evaluate each referencing foreign-key column for joins and parent update/delete checks. Add an
  index when it materially helps; document an intentional omission.
- Order composite columns to match real predicates and ordering. Avoid low-selectivity speculative
  indexes and indexes already covered by a composite prefix.
- Use partial, expression, or `INCLUDE` indexes only for demonstrated query shapes, accounting for
  write amplification and storage.
- Name ordinary indexes `idx_<table>_<columns>` and unique indexes/constraints
  `uq_<table>_<columns>`.
- Use `EXPLAIN` with representative test data. Use `EXPLAIN ANALYZE` only where executing the query
  is safe; never claim a performance gain without evidence.
- Use `CREATE INDEX CONCURRENTLY` for large live tables when blocking writes is unacceptable, via
  the explicit non-transactional policy. Empty/new tables normally use transactional index creation.

ST-030 adds only the history primary key and unique name constraint; both enforce migration
integrity and are not speculative application indexes.

## Creating the next migration

1. Confirm the greatest version in `db/migrations` and create the next six-digit filename.
2. Write forward-only SQL and keep the default transaction unless PostgreSQL forbids it.
3. Review locks, compatibility, normalization, constraints, and index purpose.
4. Test migrate, validate, status, idempotent rerun, and failure behavior against disposable
   PostgreSQL 16.
5. Never edit the file after it has been applied to any shared environment.

During deployment the signed migrations image runs as a one-off Fargate task before ECS services
roll. A non-zero exit stops the deployment; schema changes are never coupled to API process boot.
