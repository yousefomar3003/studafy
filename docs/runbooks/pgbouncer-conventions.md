# PgBouncer pooling-mode conventions

Source of the pooler: [`infra/terraform/modules/pgbouncer`](../../infra/terraform/modules/pgbouncer),
sitting in front of [`infra/terraform/modules/postgres`](../../infra/terraform/modules/postgres).
This doc records _why_ transaction-pooling mode was chosen over the alternatives, what that mode
breaks, and the `SET LOCAL` convention every caller must follow because of it — the Terraform
module provisions the pooler; it cannot enforce how application code talks to it.

## Why transaction mode, not session or statement mode

PgBouncer has three pooling modes. The difference is _when_ a server (Postgres-side) connection is
returned to the pool:

| Mode          | Server connection returned to the pool | Multiplexing                                                                                                                     |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `session`     | On client disconnect                   | None beyond skipping TCP/TLS handshake cost — every client still pins one server connection for its whole session.               |
| `transaction` | On transaction commit/rollback         | High — many clients share few server connections, as long as none holds one open between transactions.                           |
| `statement`   | After every statement                  | Highest, but forbids multi-statement transactions outright — incompatible with any ORM that wraps a request in `BEGIN`/`COMMIT`. |

The actual constraint this pooler exists to relieve is RDS's `max_connections` — a fixed budget of
Postgres backend processes, not a network/TLS-handshake cost. Session mode doesn't touch that
constraint at all: a client that holds a connection idle between requests still occupies a backend
process the whole time. `statement` mode is a non-starter for `apps/api`'s ORM, which wraps request
handlers in transactions. `transaction` is the only mode that actually shrinks the backend-process
footprint under real load, which is the entire reason this ticket exists.

## What transaction mode breaks

A server connection under `transaction` mode is handed to a **different logical client** the
moment the current one commits or rolls back. Anything that client left on that connection —
session state, not transaction state — leaks to whoever gets it next, or silently vanishes. In
order of how often application code actually hits these:

| Feature                                                                      | Why it breaks                                                                                                                                                                                                | What to do instead                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SET <param> = ...`                                                          | Persists on the physical connection past commit — the _next_ client to get that connection inherits it, silently.                                                                                            | `SET LOCAL <param> = ...` — see below.                                                                                                                                                                                                   |
| `pg_advisory_lock` / `pg_advisory_unlock`                                    | Session-scoped: tied to the connection, not the transaction. A pooled connection can be handed to another client while the lock is still "held" from the first client's perspective.                         | `pg_advisory_xact_lock` — releases automatically at commit/rollback, exactly matching when PgBouncer returns the connection.                                                                                                             |
| `LISTEN` / `NOTIFY`                                                          | `LISTEN` registers a subscription on one specific backend connection. Under transaction pooling that connection is returned to the pool the moment the transaction ends, silently dropping the subscription. | Bypass the pooler entirely for anything using `LISTEN`/`NOTIFY` — connect straight to Postgres (the direct `app`→`db` security-group path this module deliberately did not remove; see `infra/terraform/modules/network/README.md`).     |
| `CREATE TEMP TABLE`                                                          | Temp tables are session-scoped. The table (or a naming collision) leaks into whatever client the connection goes to next.                                                                                    | Avoid temp tables under the pooled path, or issue `ON COMMIT DROP` and never rely on the table surviving past the transaction that created it — and even then, prefer the direct path.                                                   |
| Named/server-side prepared statements                                        | Prepared on one physical connection; the client has no guarantee of reconnecting to the same one for a later `EXECUTE`.                                                                                      | Let the driver/ORM use unnamed statements (most do by default under a pooler), or confirm the deployed PgBouncer version's prepared-statement support (`max_prepared_statements`, added in PgBouncer 1.21) before relying on named ones. |
| `CREATE INDEX CONCURRENTLY` and other DDL requiring session-level guarantees | Needs a connection that isn't reused mid-operation by another client, and some DDL simply can't run pooled correctly.                                                                                        | Run migrations over the direct `app`→`db` path, not through PgBouncer.                                                                                                                                                                   |
| Connection reset between transactions                                        | PgBouncer's transaction mode does **not** run `DISCARD ALL` between transactions — nothing resets session state for you.                                                                                     | Don't rely on the connection coming back "clean"; the items above are the actual list of what can leak.                                                                                                                                  |

## The `SET LOCAL` rule

Any per-request configuration — a tenant ID exposed as a GUC for row-level security, a
per-request `statement_timeout` override, a `search_path` override — must be issued as
`SET LOCAL`, never `SET`, on every pooled connection:

```sql
BEGIN;
SET LOCAL statement_timeout = '5s';
SET LOCAL app.school_id = '00000000-0000-4000-8000-000000000001';
-- ... the transaction's actual queries ...
COMMIT;
```

`SET LOCAL`'s scope is the current transaction: it resets automatically at `COMMIT` or `ROLLBACK`.
That is not a coincidental match with PgBouncer's transaction-mode handoff point — it's the same
boundary. `SET` (without `LOCAL`) has session scope, which under transaction pooling means "until
some other client's transaction happens to run on this same physical connection," which is not a
guarantee any application should build on. If `apps/api`'s ORM issues a bare `SET` anywhere
(connection-level configuration hooks are the usual culprit), it must be changed to `SET LOCAL`
before that code path is allowed to run through the pooler.

## Auth and TLS

See [`infra/terraform/modules/pgbouncer/README.md`](../../infra/terraform/modules/pgbouncer/README.md)
for the full design. Summary: client connections require TLS (`sslmode=verify-ca` against the CA
cert in `connection_secret_arn`, not `verify-full` — there's no stable DNS name for this single
instance yet); every `service_pools` entry authenticates to Postgres as the same master user
(no per-service Postgres role exists yet — `postgres-conventions.md`'s "Known gaps"), so
"per-service pools" here means per-service connection budgets (`pool_size`), not per-service
database privileges.

## Known gaps (not covered by the `pgbouncer` module's ticket)

- **Single instance, no HA.** Not an Auto Scaling Group behind a load balancer — this ticket didn't
  ask for HA, and a second instance needs either a load balancer or a stable private DNS name this
  repo has no precedent for yet. The pooler is a single point of failure between the app tier and
  an otherwise-HA Postgres pair.
- **No per-service Postgres role.** Every pool authenticates as the master user; least-privilege
  per-service roles are scoped to whichever ticket adds the first schema/migration (same gap
  `postgres-conventions.md` already flags for direct connections).
- **`verify-ca`, not `verify-full`.** Accepted for the same "no stable DNS name" reason as above;
  revisit once the instance has one (e.g. a private Route 53 zone).
- **Package availability unverified.** `user_data` assumes `dnf install -y pgbouncer` succeeds on
  Amazon Linux 2023's default repos. This was written without an AWS account to apply against; if
  the package isn't there, the instance boots with no PgBouncer running at all. Check first on
  a failed apply.
- **No alerting on `ClientsWaiting`.** The metric is exported (this ticket's acceptance criterion);
  a CloudWatch alarm on sustained saturation is not created, because no alerting destination
  (PagerDuty/Slack/SNS topic) exists yet in this repo to alarm into.

## Out of scope: indexing and normalization

PgBouncer is a connection-routing layer — it has no effect on query plans, index usage, or schema
normalization, and this ticket touches no schema. Index design and normalization belong to
whichever ticket owns the schema itself (`modules/postgres`'s master-credential/migration gap
above, or the first migration tooling ticket) — noted here only so this doc doesn't silently skip
a question it was asked, not because there's anything pooling-specific to say about it.
