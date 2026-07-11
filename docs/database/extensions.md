# PostgreSQL extension policy

Studafy's PostgreSQL 16 cluster enables four extensions. They are turned on by the ordered migration
[`db/migrations/000003_enable_required_postgresql_extensions.sql`](../../db/migrations/000003_enable_required_postgresql_extensions.sql)
using the ST-030 framework ([migration policy](./migration-policy.md)) and the ST-031 role model
([role model](./role-model.md)). This document is the authority for why each extension is enabled,
how it is secured, and the normalization/indexing rules that govern its use.

Enabling an extension grants a **capability**, not a schema. This ticket adds **no** application
tables and **no** extension-backed indexes — those are separate, evidence-driven decisions (see
[Indexing rules](#indexing-rules)).

## Required extensions

| Extension          | Exact name           | Why it is enabled                                                       | Preload required |
| ------------------ | -------------------- | ----------------------------------------------------------------------- | ---------------- |
| pgcrypto           | `pgcrypto`           | Cryptographic hashing (`digest`, `hmac`) and secure random bytes.       | No               |
| pg_trgm            | `pg_trgm`            | Trigram similarity and index operator classes for fuzzy / ILIKE search. | No               |
| pgvector           | `vector`             | Vector type and distance operators for embedding similarity search.     | No               |
| pg_stat_statements | `pg_stat_statements` | Aggregated query-execution telemetry for performance observability.     | **Yes**          |

- **Supported PostgreSQL version:** 16. `family = "postgres16"` in the RDS parameter group; local/CI
  use `pgvector/pgvector:pg16`.
- **The pgvector extension name is `vector`, not `pgvector`.** The migration uses
  `CREATE EXTENSION IF NOT EXISTS vector;`.
- **Recorded versions:** run `SELECT extname, extversion FROM pg_extension ORDER BY extname;` in each
  environment and record the result there. Versions come from the running server / image and are not
  pinned by this repository; they may differ between the local `pgvector/pgvector:pg16` image and
  RDS's allowlisted builds. Do not assume a version — read it from `pg_extension`.

### pgcrypto — approved use cases

- Hashing (`digest`, `hmac`) and secure random material (`gen_random_bytes`).
- **UUIDs use core `gen_random_uuid()`** (built into PostgreSQL 13+), not pgcrypto and not
  application-generated IDs. The database is the canonical UUID generator; do not duplicate that in
  application code.
- **Not** approved: SQL-level password hashing/storage (`crypt`/`gen_salt`) — authentication is an
  application-security boundary and no design requires database-side password handling. Ad-hoc
  column encryption is **not** a substitute for that boundary and must not be introduced without a
  documented design.
- pgcrypto functions are pure computation; they keep the PostgreSQL default (`EXECUTE` to `PUBLIC`).
  `studafy_app` is granted nothing extra. Revisit if an authentication or key-management design ever
  introduces sensitive key material into SQL.

## Ownership model

Installing any of these extensions requires superuser (`rds_superuser` on RDS). They are therefore
owned by the **migration-runner identity** — the login that runs migrations (local/CI: the
`studafy_test` superuser; RDS: the master user). The migration deliberately does **not**
`SET ROLE studafy_admin`: `studafy_admin` is `NOSUPERUSER` and cannot create extensions, and
extension installation must stay an administrative operation.

- `studafy_app` owns **no** extension and cannot `CREATE`/`ALTER`/`DROP` any extension.
- `studafy_monitor` owns **no** extension and cannot manage extensions.
- Verify:
  ```sql
  SELECT extname, pg_get_userbyid(extowner) AS owner FROM pg_extension ORDER BY extname;
  ```

## Runtime-role restrictions

`studafy_app` (application runtime, per [role model](./role-model.md)) receives **no** additional
grant from this migration:

- pgcrypto / pg_trgm / vector functions and types are usable via their PostgreSQL default
  (`EXECUTE`/`USAGE` to `PUBLIC`) — pure computation with no privilege implication.
- `studafy_app` has **no** access to `pg_stat_statements` (see below).
- Extension management (`CREATE`/`ALTER`/`DROP EXTENSION`) is denied.

## pg_stat_statements — monitoring policy

### Preload requirement (infrastructure-controlled)

`CREATE EXTENSION pg_stat_statements` succeeding does **not** mean it is collecting statistics. The
module must be loaded through `shared_preload_libraries`, which is a **static** server parameter:

- **RDS / managed:** set in the parameter group. This repo sets
  `shared_preload_libraries = 'pg_stat_statements'` (`apply_method = pending-reboot`) in
  [`infra/terraform/modules/postgres/main.tf`](../../infra/terraform/modules/postgres/main.tf).
  Because it is static, it applies on the instance's first boot; **changing it on a running instance
  requires a reboot.** No reboot ⇒ the extension exists but the views raise on read.
- **Local / CI:** `db/compose.yml` starts Postgres with
  `-c shared_preload_libraries=pg_stat_statements`, so operationality is genuinely exercised.

The migration warns (does not fail) when the library is not preloaded, so the other three extensions
still enable on any Postgres 16. The hard, fail-closed check lives in the tests and the
[verification procedure](#environment-verification-procedure).

### Access control

The extension grants `SELECT` on its views to `PUBLIC` by default, exposing call counts and timing
to every role. The migration removes that and grants read access to `studafy_monitor` only:

```sql
REVOKE ALL ON public.pg_stat_statements FROM PUBLIC;      -- and pg_stat_statements_info
GRANT  SELECT ON public.pg_stat_statements TO studafy_monitor;
GRANT  pg_read_all_stats TO studafy_monitor;
```

- **`studafy_monitor`** is a `NOLOGIN` privilege/group role (same pattern as ST-031's roles): the
  login identity is provisioned externally in Secrets Manager and granted membership; no password is
  written in SQL. It carries the same safe attribute baseline
  (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOLOGIN`) and receives only
  `CONNECT` on the database plus the grants above.
- **`pg_read_all_stats`, not `pg_monitor`.** `pg_read_all_stats` is the narrowest built-in role that
  lets a non-superuser see the **full query text** of other roles' statements in
  `pg_stat_statements`. `pg_monitor` additionally bundles `pg_read_all_settings` and
  `pg_stat_scan_tables`, which monitoring here does not need.
- **`studafy_app` and `PUBLIC` get nothing.** `studafy_app` cannot read the view (denied by
  privilege, before the view is evaluated).
- **`pg_stat_statements_reset()` stays superuser-only** (its default). Resetting telemetry is an
  administrative action; `studafy_monitor` is read-only.

### Query-text sensitivity and privacy

Statement text can embed literals (identifiers, search terms, and — if code inlines them instead of
using bind parameters — personal data). Treat it as sensitive:

- Never expose `pg_stat_statements` rows or query text through an application API.
- Only `studafy_monitor` (and superusers) may read it. Non-privileged roles that could otherwise see
  the view get `<insufficient privilege>` for other users' text; here they get no access at all.
- Monitoring credentials live in Secrets Manager and must never reach application runtime
  configuration.

### Reset and retention behavior

`pg_stat_statements` keeps an **in-memory**, fixed-size table (`pg_stat_statements.max`, default
5000 statements) — not durable history. Entries are evicted under pressure, cleared by
`pg_stat_statements_reset()`, and lost on server restart/failover. It is a live sampling tool, not an
audit log; export to a metrics pipeline if history is needed.

## Environment coverage

The migration is identical across dev, staging, and production. Only these differ per environment and
must be verified/documented:

| Aspect                           | Where it is controlled                                       |
| -------------------------------- | ------------------------------------------------------------ |
| PostgreSQL major version (16)    | RDS `engine_version` / local image                           |
| Extension availability + version | Provider allowlist / image; read from `pg_extension`         |
| `pg_stat_statements` preload     | Parameter group (RDS) / compose command (local, CI)          |
| Reboot to apply preload          | Operator-scheduled on RDS                                    |
| Permission to install            | `rds_superuser` (RDS) / superuser (local, CI)                |
| Credentials / connection         | Secrets Manager (deployed) / `TEST_DATABASE_URL` (local, CI) |

**Managed-provider note (AWS RDS):** `vector`, `pgcrypto`, and `pg_trgm` are on the RDS Postgres 16
extension allowlist and need no parameter-group change. Only `pg_stat_statements` needs the preload
parameter (and a reboot to apply it on a running instance).

## Environment verification procedure

Run against each accessible environment (never destructively against shared staging/production):

```sql
-- 1. All four present, with versions.
SELECT extname, extversion, pg_get_userbyid(extowner) AS owner
FROM pg_extension WHERE extname IN ('pgcrypto','pg_trgm','vector','pg_stat_statements')
ORDER BY extname;

-- 2. pg_stat_statements is actually operational (raises if not preloaded -- treat as a failure).
SELECT count(*) FROM pg_stat_statements;

-- 3. Access is restricted.
SELECT has_table_privilege('studafy_app', 'public.pg_stat_statements', 'SELECT')      AS app_can_read,      -- expect false
       has_table_privilege('studafy_monitor', 'public.pg_stat_statements', 'SELECT')  AS monitor_can_read,  -- expect true
       pg_has_role('studafy_monitor', 'pg_read_all_stats', 'USAGE')                   AS monitor_reads_stats; -- expect true
```

If step 2 raises `pg_stat_statements must be loaded via shared_preload_libraries`, the environment is
**not** operational: fix the parameter group and reboot; do not report success.

## Local development setup

```bash
POSTGRES_PASSWORD='<local-only>' docker compose -f db/compose.yml up -d --wait
export TEST_DATABASE_URL='postgresql://studafy_test:<local-only>@127.0.0.1:54329/postgres?sslmode=disable'
bun run db:migrate            # applies 000001..000003
bun test --cwd packages/db    # includes extensions.test.ts and roles.test.ts
docker compose -f db/compose.yml down
```

PowerShell uses the same values via `$env:POSTGRES_PASSWORD` / `$env:TEST_DATABASE_URL`.

## CI validation

The `database-migrations` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) starts
the database from `db/compose.yml` (so the pgvector image and `pg_stat_statements` preload match
local development) and runs the whole `packages/db` suite, which applies the migrations to a fresh
disposable database and verifies every extension, including that `pg_stat_statements` collects
statistics.

## Failure modes

| Symptom                                                          | Cause / action                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `CREATE EXTENSION vector` fails: extension not available         | Image/provider lacks pgvector. Use `pgvector/pgvector:pg16`; confirm the RDS allowlist.            |
| Migration warns "not in shared_preload_libraries"                | Preload not configured. Set the parameter group and reboot (RDS); the other extensions still work. |
| `SELECT ... FROM pg_stat_statements` raises "must be loaded ..." | Same as above — not operational until preloaded and restarted.                                     |
| `permission denied for view pg_stat_statements` as the app role  | Expected: only `studafy_monitor` may read it.                                                      |
| `studafy_app` blocked from `CREATE/ALTER/DROP EXTENSION`         | Expected: extension management is administrative.                                                  |

## Upgrade policy

Extension versions are **not** auto-bumped. `CREATE EXTENSION IF NOT EXISTS` installs the default
version for the server and leaves an already-installed extension untouched. Upgrading (`ALTER
EXTENSION ... UPDATE`) is a deliberate, separately reviewed migration — pgvector in particular can
change index build behavior between versions. Record the before/after `extversion` and test against
representative data before upgrading a shared environment.

## Security considerations

- No credentials, connection strings, or secrets appear in the migration, this document, or CI —
  only role names and placeholders, which are not secrets.
- Extension installation stays superuser-only; runtime and monitoring roles cannot manage extensions.
- `pg_stat_statements` is readable only by `studafy_monitor`; `PUBLIC` and `studafy_app` have no
  access. Monitoring credentials never enter application runtime.
- No `CREATE` on the database is granted to the app so it could self-install extensions.

## Normalization rules

Extensions add capabilities; they do not relax the [normalization standard](./migration-policy.md#normalization-standard)
(1NF–3NF by default). Extension-specific rules:

- **pgcrypto.** UUIDs from `gen_random_uuid()` do not replace primary-key/uniqueness design.
  Encrypted payloads are not a substitute for structured relational columns; never encrypt values
  that must be searched, joined, or constrained without a documented design. Store cryptographic
  metadata (algorithm, key version) separately when lifecycle/versioning requires it.
- **pgvector.** An embedding is **derived** data, never the source of truth. A future embedding table
  must reference its entity with an explicit foreign key, store the model identity + version and a
  consistent dimension, and preserve the normalized source content. Do not mix unrelated entity
  types in one generic vector table without a strong polymorphic design, and do not use vectors to
  replace normalized tags, categories, relationships, or permissions. Document how embeddings are
  regenerated when source content changes.
- **pg_trgm.** Fuzzy/similarity matching does not establish identity and does not replace unique
  constraints. Normalize canonical names, emails, identifiers, and codes with their own columns and
  constraints. Add a search-oriented derived column only when justified, documenting its source
  fields and refresh strategy; do not store pre-concatenated search blobs casually.
- **pg_stat_statements.** Operational telemetry, not application domain data. Do not copy statement
  statistics into business tables and do not expose query text through APIs.

No application/domain tables were invented in this ticket to demonstrate any extension.

## Indexing rules

Follow the [indexing standard](./migration-policy.md#indexing-standard). **Enabling an extension does
not justify an index.** No vector or trigram index is added here because no schema and no query
workload exist yet; adding one would be speculative. `public.schema_migrations` already has its
primary key on `version` and unique constraint on `name` (ST-030), which cover version lookup and
ordered status — no additional index is warranted.

### pgvector index decision framework

Create a vector index only when **all** of the following are known: target table, vector column,
dimensions, distance operator (`<=>` cosine, `<#>` inner product, `<->` L2, `<+>` L1 where
supported), query pattern, approximate recall target, expected row count, insert/update frequency,
and latency requirement.

- **Exact scan** (no index): perfect recall, cost grows with row count — fine for small tables.
- **HNSW**: high recall and query speed, higher build cost/memory, slower writes. Tune build-time
  `m` and `ef_construction`; tune query-time `ef_search` for the recall/latency trade-off.
- **IVFFlat**: cheaper to build, needs **representative data present before creation** to cluster
  well. Tune `lists` at build time and `probes` at query time, and `ANALYZE` after loading.

Never create a vector index on an empty table to satisfy a task, and never claim one algorithm is
universally better — the choice depends on the factors above.

### pg_trgm index decision framework

Add a trigram index only for a **known** search query. Choose the operator class by workload:

- **GIN** (`gin_trgm_ops`): fast lookups, smaller/faster for read-heavy `LIKE`/`ILIKE`/`%` similarity
  searches; slower to update.
- **GiST** (`gist_trgm_ops`): supports distance-ordered (`<->`) nearest-match queries and cheaper
  incremental updates; generally slower lookups than GIN.

Validate locale, collation, and case-sensitivity for the target column. Name trigram indexes
`idx_<table>_<column>_trgm`. Do not index low-value text columns, and do not use a trigram index
where a normalized exact-match B-tree index is the right tool.

### Verifying any future extension-backed index

`EXPLAIN` (and `EXPLAIN ANALYZE` only on safe test data) to confirm the intended operator class is
used and the planner selects the index; confirm it is not redundant; benchmark on representative
data. Never claim a performance gain without evidence.

## What remains infrastructure-controlled

- `shared_preload_libraries` and any reboot to apply it (parameter group / provider).
- Provider extension allowlist and the concrete extension versions available.
- The external login roles that receive membership in `studafy_app` / `studafy_monitor` /
  `studafy_admin`, and their credentials in Secrets Manager.
