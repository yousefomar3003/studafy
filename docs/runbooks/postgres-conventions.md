# Postgres parameter decisions and usage conventions

Production's Postgres is the Supabase project `studafy-prod` (`eu-central-1`); connection details
are in [`infra/fly/README.md#database-connections`](../../infra/fly/README.md#database-connections),
including where Supabase differs from the RDS instance this doc was first written for. This doc
records the server settings the app was designed around and the conventions apps must follow to use
the database correctly — the provider runs the engine; it cannot enforce how callers connect to it
or what they run against it.

## Server parameters

These values were set in the retired RDS parameter group. Supabase manages its own server
configuration, and **none of them has been confirmed on the Supabase project yet**; check each
(`SHOW <parameter>;`) before relying on it.

| Parameter                    | Intended value | Why                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `statement_timeout`          | `30000` ms     | Caps how long any single statement can run before Postgres cancels it. Protects the app tier's connection pool from being exhausted by one runaway query or a query stuck behind a lock. **30 seconds is an unresearched starting point** — revisit once real p99 query latency is known; a value too low will start cancelling legitimate slow reports/migrations. |
| `log_min_duration_statement` | `1000` ms      | Logs any statement slower than 1 second, so slow queries surface without logging every single query.                                                                                                                                                                                                                                                                |
| `log_connections`            | `1`            | Logs every new connection — needed to see connection-pool exhaustion or unexpected clients.                                                                                                                                                                                                                                                                         |
| `log_disconnections`         | `1`            | Paired with `log_connections`, so connection lifetime is visible, not just connection count.                                                                                                                                                                                                                                                                        |
| `log_lock_waits`             | `1`            | Logs any statement that waits longer than `deadlock_timeout` for a lock — the first signal for the kind of lock contention `statement_timeout` is a blunt backstop against.                                                                                                                                                                                         |

Supabase's Postgres logs are in the Supabase dashboard, not in Axiom (the log shipper carries only
the fly apps' own output).

## TLS

Every connection is TLS, verified against Supabase's root CA: `DATABASE_SSL_MODE = "verify-full"`
in `infra/fly/api.toml`, `workers.toml` and `migrate.toml`, with the CA in `DATABASE_CA_CERT`.
Never use `sslmode=disable` or `sslmode=allow`.

## Credentials

The services and migrations log in as the project's `postgres` user (through the pooler as
`postgres.<project ref>`); its password is the `DATABASE_PASSWORD` secret in the `prod` GitHub
Environment ([`secrets-conventions.md`](secrets-conventions.md)), never committed config. Supabase's
`postgres` is not a superuser; the consequences for migrations (`createrole_self_grant`, the CONNECT
grants of migration 000202) are in [`infra/fly/README.md`](../../infra/fly/README.md#where-supabase-differs-from-rds).
Rotation: [`security/rotation-db.md`](security/rotation-db.md).

## Extensions

Four extensions are enabled by migration
[`db/migrations/000003_enable_required_postgresql_extensions.sql`](../../db/migrations/000003_enable_required_postgresql_extensions.sql),
not by hand — the full policy (ownership, monitoring access, normalization, and indexing) is in
[`docs/database/extensions.md`](../database/extensions.md). Two things are provider concerns and
belong here.

`vector` (pgvector), `pgcrypto`, and `pg_trgm` are enabled by the migration per database. Verify:

```sql
SELECT extname, extversion FROM pg_extension
WHERE extname IN ('vector', 'pgcrypto', 'pg_trgm', 'pg_stat_statements') ORDER BY extname;
```

`pg_stat_statements` is different: it only collects statistics when its shared library is
preloaded, and on Supabase it is installed by the platform in its own `extensions` schema. That is
why production applied migration 000003 without its three `studafy_monitor` grants
([`infra/fly/README.md`](../../infra/fly/README.md#where-supabase-differs-from-rds)).
`CREATE EXTENSION pg_stat_statements` succeeding is not proof the telemetry is operational; confirm
with:

```sql
SELECT count(*) FROM pg_stat_statements;   -- raises if the library is not preloaded
```

## Failover and backups

Failover, backups and point-in-time recovery are Supabase's, under the project's plan. No failover
or restore procedure for Supabase has been written or drilled yet; see
[`dr/README.md`](dr/README.md).

## Known gaps

- **The server parameters above are unconfirmed on Supabase.**
- **No application database role.** The app runs as Supabase's `postgres` user; moving it to a
  dedicated `NOBYPASSRLS` login is the open follow-up in
  `docs/security/S-01-database-role-verification.md`.
- **No monitoring login.** The app does not use `studafy_monitor`, and no metrics exporter runs
  against the database; Supabase's dashboard is the only view of database health.
