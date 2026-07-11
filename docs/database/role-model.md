# Database role and grant model

Studafy's PostgreSQL 16 cluster uses two purpose-built roles under least privilege and separation
of duties. They are created by the ordered migration
[`db/migrations/000002_create_database_roles_and_grants.sql`](../../db/migrations/000002_create_database_roles_and_grants.sql)
using the ST-030 framework ([migration policy](./migration-policy.md)). This document records the
model and why each choice was made; it is the authority for how future migrations grant access.

## Role overview

| Role            | Purpose                               | Login   | Owns objects                                |
| --------------- | ------------------------------------- | ------- | ------------------------------------------- |
| `studafy_admin` | Migrations and controlled maintenance | NOLOGIN | Yes — the `app` schema and everything in it |
| `studafy_app`   | Application runtime (CRUD only)       | NOLOGIN | No — never                                  |

Both roles carry the identical safe attribute baseline:

```text
NOSUPERUSER  NOCREATEDB  NOCREATEROLE  NOREPLICATION  NOBYPASSRLS  NOLOGIN
```

### `studafy_app` — application runtime

The role the API and other runtime services act as. It receives only the privileges required for
CRUD on the application schema:

- `CONNECT` on the application database
- `USAGE` on schema `app` (never `CREATE`)
- `SELECT, INSERT, UPDATE, DELETE` on `app` tables created by `studafy_admin` (via default
  privileges)
- `USAGE, SELECT` on `app` sequences (for `nextval()`/`currval()` behind identity/serial columns)

It receives **no** `EXECUTE` on functions by default, **no** DDL, **no** grant management, and **no**
access to migration metadata, `public`, or any object it does not need. Because it never owns an
object and is `NOBYPASSRLS`, it can never bypass Row-Level Security.

### `studafy_admin` — migrations and maintenance

Owns the `app` schema and all application objects, so migrations can create and alter tables,
sequences, indexes, and functions, and manage grants on them. Its authority comes from **schema
ownership**, not from role attributes — it deliberately stays `NOCREATEDB`/`NOCREATEROLE`/
`NOSUPERUSER` because creating tables inside an owned schema requires none of those. It is not a
superuser; nothing in the current managed-Postgres design requires it to be.

## Login vs group-role decision

Both roles are `NOLOGIN` **privilege/group roles**. The actual login identities are provisioned
outside the repository in AWS Secrets Manager and receive membership:

- The runtime login (the PgBouncer `api` user — see
  [`infra/deploy/ecs/api/task-definition.json.tpl`](../../infra/deploy/ecs/api/task-definition.json.tpl))
  is granted membership in `studafy_app`.
- The migration login (the RDS master user — see
  [`infra/deploy/ecs/migrations/task-definition.json.tpl`](../../infra/deploy/ecs/migrations/task-definition.json.tpl))
  is granted membership in `studafy_admin`.

This keeps the migration portable and free of credentials: **no password is ever written in SQL**,
and rotating a login never touches the privilege model. The membership grant
(`GRANT studafy_app TO <runtime_login>` / `GRANT studafy_admin TO <migration_login>`) is an external,
deployment-time step because the login names live in Secrets Manager, not in the repo. In local and
CI databases the superuser test connection exercises the roles with `SET ROLE`.

## Ownership model

```text
studafy_admin ── owns ──> schema app ── owns ──> future tables / sequences / indexes / functions
studafy_app  ── granted ─> USAGE + CRUD + sequence USAGE/SELECT (via default privileges)
```

`studafy_app` owns nothing — verified against the system catalogs, not just the SQL text (see
[`packages/db/tests/roles.test.ts`](../../packages/db/tests/roles.test.ts)). The migration metadata
table `public.schema_migrations` is owned by the migration runner identity, not by `studafy_app`.

### Why the application role must not own tables

A table's owner can `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` and generally bypass RLS on its own
tables regardless of `NOBYPASSRLS`. Keeping ownership with `studafy_admin` and granting `studafy_app`
only DML is what makes RLS enforceable against the runtime role.

### Why `BYPASSRLS` is prohibited

`studafy_app` is `NOBYPASSRLS` so that once a table has RLS enabled with a policy, the runtime role
is always subject to that policy. Granting `BYPASSRLS` would silently defeat every row-level rule.

## Runtime vs migration credentials

The two connect with **different credentials from different secrets**, and the separation is
structural rather than a naming convention:

| Aspect        | Runtime (`apps/api`)                    | Migrations                     |
| ------------- | --------------------------------------- | ------------------------------ |
| Secret        | `PGBOUNCER_SECRET_ARN` (`api_*` fields) | `POSTGRES_SECRET_ARN` (master) |
| Connects via  | PgBouncer, port 6432                    | RDS directly, port 5432        |
| Role          | member of `studafy_app`                 | member of `studafy_admin`      |
| Env variables | discrete `DATABASE_*`                   | discrete `DATABASE_*`          |

### Why not `MIGRATION_DATABASE_URL`

The repository uses discrete `DATABASE_*` variables per service, each injected from a different
secret; [`packages/db/src/config.ts`](../../packages/db/src/config.ts) rejects mixing a `DATABASE_URL`
with the discrete form. Introducing a `MIGRATION_DATABASE_URL` would add a second, conflicting
configuration shape for a separation that already exists at the secret/task-definition boundary. The
static checks in [`packages/db/tests/config-separation.test.ts`](../../packages/db/tests/config-separation.test.ts)
assert this boundary instead: API source never references `studafy_admin` or a migration-only URL,
the web/mobile clients carry no database URLs or credentials, and the API and migration task
definitions draw from different secrets.

## Public schema and database hardening

The migration removes the permissive PostgreSQL defaults on the application database:

- `REVOKE CONNECT, TEMPORARY ON DATABASE <db> FROM PUBLIC`, then explicit `GRANT CONNECT` to
  `studafy_admin` and `studafy_app` only.
- `REVOKE CREATE ON SCHEMA public FROM PUBLIC` (PostgreSQL 16 already withholds this; the statement
  is explicit defense in depth and a no-op on a compliant cluster).
- `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` so new functions are not
  world-executable.

No application-object access is granted to `PUBLIC`.

## Default privileges

Configured **for the creating role** (`studafy_admin`), **in schema** `app`, **per object type**:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO studafy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO studafy_app;
-- No IN SCHEMA here — see note below.
ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

Default privileges are **not global in scope** — the `GRANT` entries apply only to objects created
afterward, by the named role (`studafy_admin`), in the named schema (`app`), of the named type.
Objects created by any other role, in any other schema, are unaffected. Sequence `UPDATE` (`setval`)
is intentionally withheld; the application never rewinds a sequence.

The function `REVOKE` deliberately omits `IN SCHEMA app`. PostgreSQL per-schema default privileges
can only **add** to the built-in global default, never **remove** from it, so `IN SCHEMA app REVOKE
EXECUTE ON FUNCTIONS FROM PUBLIC` is a silent no-op — PUBLIC keeps the built-in `EXECUTE`. Revoking
PUBLIC's default `EXECUTE` must therefore be done at the role's global level. It still affects only
functions created by `studafy_admin`, which only creates objects in `app`.

## How future migrations grant access

Because default privileges are scoped to the creating role, an object-creating migration must run as
`studafy_admin` so its tables inherit the grants above and are owned correctly:

```sql
SET ROLE studafy_admin;

CREATE TABLE app.example (
  id integer GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_example PRIMARY KEY,
  ...
);

RESET ROLE;
```

Function execution is never automatic — grant it explicitly and narrowly when a function exists:

```sql
GRANT EXECUTE ON FUNCTION app.some_function(args) TO studafy_app;
```

Never `GRANT ALL`, never grant application objects to `PUBLIC`, and never grant `studafy_app` DDL or
ownership.

## How to verify privileges

```sql
-- Role attributes (all six flags must be false for both roles)
SELECT
  rolname,
  rolsuper,
  rolcreatedb,
  rolcreaterole,
  rolreplication,
  rolbypassrls
FROM pg_roles
WHERE rolname IN ('studafy_app', 'studafy_admin');

-- Schema ownership
SELECT nspname, pg_get_userbyid(nspowner) AS owner
FROM pg_namespace WHERE nspname = 'app';

-- What studafy_app can do to a table
SELECT has_table_privilege('studafy_app', 'app.<table>', 'SELECT,INSERT,UPDATE,DELETE');

-- Confirm PUBLIC holds nothing on the application schema
SELECT has_schema_privilege('public', 'app', 'CREATE'),
       has_schema_privilege('public', 'app', 'USAGE');
```

## Managed PostgreSQL (RDS) limitations and assumptions

- The migration is verified against a local/CI **superuser** PostgreSQL 16 cluster. On RDS the
  migration login is `rds_superuser`, not a true superuser. In PostgreSQL 16 a `CREATEROLE`/
  `rds_superuser` role that creates another role automatically receives membership (with `SET`) in
  it, which is what allows `ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin` and
  `CREATE SCHEMA ... AUTHORIZATION studafy_admin` to run. If a future managed constraint prevents
  this, grant the migration login membership in `studafy_admin` before running migrations.
- `rds.force_ssl = 1` (see [postgres conventions](../runbooks/postgres-conventions.md)) requires
  `sslmode=require` or stricter in every real connection; only the disposable local/CI database uses
  `sslmode=disable`.

## Local and CI test setup

Integration tests are gated by `TEST_DATABASE_URL` and run against fresh, disposable databases.

```bash
POSTGRES_PASSWORD='<local-only>' docker compose -f db/compose.yml up -d --wait
export TEST_DATABASE_URL='postgresql://studafy_test:<local-only>@127.0.0.1:54329/postgres?sslmode=disable'
bun test --cwd packages/db
docker compose -f db/compose.yml down
```

CI runs the whole `packages/db` suite (including `roles.test.ts`) against a `postgres:16.4-alpine`
service in the `database-migrations` job of [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
The static `config-separation.test.ts` runs in every lane, database or not.

## Credential handling

No passwords or database URLs are stored in SQL, committed configuration, or logs. The runner
redacts connection strings and passwords from error messages, and the CI service password belongs
only to an ephemeral container. Membership grants that bind a login to `studafy_app`/`studafy_admin`
are a Secrets-Manager-driven deployment step, not a repository artifact.

## Normalization and indexing policy

This task is security-focused and adds **no application tables** — the general standards are in the
[migration policy](./migration-policy.md#normalization-standard). For the objects this ticket does
touch:

- **Normalization.** Test fixtures follow 1NF–3NF: atomic columns, identity primary keys, named
  `UNIQUE` constraints, explicit foreign keys with defined `ON DELETE` behavior, no JSONB, no
  duplicated facts. No production business tables were invented to demonstrate normalization.
- **Indexes added: none.** The migration creates only roles, one schema, and grants. Fixture
  primary-key and unique constraints supply their own indexes; the fixture foreign-key column carries
  no query workload, so no additional index is warranted. Adding one would be speculative.
- **Foreign-key index review.** PostgreSQL does not auto-index a referencing column. For each future
  application foreign key, review join frequency, parent delete/update behavior, and expected row
  counts, then add an `idx_<table>_<columns>` index only where it materially helps and document any
  intentional omission.
- **Migration metadata.** `public.schema_migrations` already has a primary key on `version` and a
  unique constraint on `name` (ST-030); those cover version lookup and ordered status queries, so no
  additional index is added.
- **Documenting intentional denormalization / justifying future indexes.** Record the reason, source
  of truth, consistency strategy, and the measured or expected query need — with `EXPLAIN` evidence
  for any index claimed to improve performance.
