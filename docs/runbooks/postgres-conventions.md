# Postgres parameter decisions and usage conventions

Source of the Postgres instance: [`infra/terraform/modules/postgres`](../../infra/terraform/modules/postgres).
This doc records _why_ each parameter-group setting has the value it does, and the conventions apps
must follow to use the instance correctly — the Terraform module provisions the engine; it cannot
enforce how callers connect to it or what they run against it.

## Parameter group decisions

| Parameter                    | Value      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rds.force_ssl`              | `1`        | Rejects any connection that doesn't negotiate TLS. There's no existing plaintext consumer to migrate (no compute tier exists yet — `infra/terraform/README.md`), so there's no transitional reason to allow one. This is a static parameter; it takes effect on the instance's first boot since it's part of the parameter group from creation.                                                                                                                                 |
| `statement_timeout`          | `30000` ms | Caps how long any single statement can run before Postgres cancels it. Protects the app tier's connection pool from being exhausted by one runaway query or a query stuck behind a lock. **30 seconds is an unresearched starting point** — no query-latency profile exists for this app yet (same honesty gap as `instance_class`'s dev-only default). Revisit once real p99 query latency is known; a value too low will start cancelling legitimate slow reports/migrations. |
| `log_min_duration_statement` | `1000` ms  | Logs any statement slower than 1 second, so slow queries surface in CloudWatch Logs without logging every single query (which `log_statement=all` would do, at significant log-volume cost).                                                                                                                                                                                                                                                                                    |
| `log_connections`            | `1`        | Logs every new connection — needed to see connection-pool exhaustion or unexpected clients in CloudWatch Logs.                                                                                                                                                                                                                                                                                                                                                                  |
| `log_disconnections`         | `1`        | Paired with `log_connections`, so connection lifetime is visible, not just connection count.                                                                                                                                                                                                                                                                                                                                                                                    |
| `log_lock_waits`             | `1`        | Logs any statement that waits longer than `deadlock_timeout` for a lock — the first signal for the kind of lock contention `statement_timeout` is a blunt backstop against.                                                                                                                                                                                                                                                                                                     |

`statement_timeout` and `log_min_duration_statement` apply immediately (no reboot); `rds.force_ssl`
is a static parameter that only takes a reboot to apply to an _already-running_ instance — moot
here since the instance is created with this parameter group attached from the start.

## TLS

`rds.force_ssl = 1` means the instance rejects a non-SSL connection outright. Use `sslmode=require`
(or stricter, `verify-full` with the RDS CA bundle) in every connection string — never
`sslmode=disable` or `sslmode=allow`. This mirrors `../../infra/terraform/modules/redis`'s
`transit_encryption_mode = "required"`: TLS mandatory, no plaintext fallback, for the same reason
(no existing plaintext consumer to preserve compatibility with).

## Master credential

The master password lives in Secrets Manager, not in a connection string as committed config. The
module outputs `postgres_connection_secret_arn` (root) / `connection_secret_arn` (module); the
secret's JSON value is `{ host, port, dbname, username, password, sslmode }`. Whatever wires
environment variables for a deployed service (no compute tier exists yet — see
`infra/terraform/README.md`) is responsible for assembling a connection string from that secret at
deploy time, e.g.:

```
DATABASE_URL=postgresql://${username}:${password}@${host}:${port}/${dbname}?sslmode=${sslmode}
```

Never write the password into a `*.tfvars` file, a `terraform output` consumed by CI logs, or a
`.env` file committed to the repo. The master credential is for provisioning/migrations, not for
`apps/api`'s runtime connection pool — once a compute tier and schema-migration tooling exist,
create a least-privilege application role instead of running the app as the master user; this
module doesn't create one today because nothing yet connects to enforce that separation.

## pgvector

AWS's Postgres 16 extension allowlist already includes `vector` — no parameter-group change or
`shared_preload_libraries` entry is needed to make it available. It still has to be enabled per
database, and Terraform has no SQL access to do that (the same limit noted in
`../../infra/terraform/modules/redis/README.md` for verifying TLS manually). Run this once per
database, after the instance exists:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Verify it's active:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

## Failover

The pair fails over automatically — RDS Multi-AZ (`multi_az = true`) keeps a synchronous,
non-readable standby in a second AZ and promotes it on primary failure or a forced test. To
exercise the dev acceptance criterion ("failover tested in dev"), see the
`aws rds reboot-db-instance --force-failover` procedure in
[`../../infra/terraform/modules/postgres/README.md`](../../infra/terraform/modules/postgres/README.md#running-the-dev-failover-drill).
A client connected via the instance's DNS endpoint reconnects to the new primary automatically once
RDS repoints it; no fixed node IP is ever handed to a caller.

## Known gaps (not covered by the `infra/terraform/modules/postgres` ticket)

- No compute tier exists yet, so nothing in this repo currently sets `DATABASE_URL` to point at the
  provisioned instance, and no app-level `pg`/Prisma/TypeORM client exists to consume it. The
  "instance reachable from the app subnet only" and "TLS enforced" acceptance criteria can only be
  exercised manually today (e.g. `psql "host=<address> port=5432 sslmode=require ..."` from the
  bastion) until a compute module exists to wire the environment variable for real.
- No application database role exists — only the master user. Creating one is scoped to whatever
  ticket adds the first schema/migration.
