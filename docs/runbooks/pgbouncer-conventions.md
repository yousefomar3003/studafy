# PgBouncer pooling-mode conventions

In production the services connect through Supabase's **transaction** pooler
(`aws-1-eu-central-1.pooler.supabase.com`, port 6543), which plays the part a self-hosted PgBouncer
played on AWS; migrations connect directly (`db.<project ref>.supabase.co:5432`). See
[`infra/fly/README.md#database-connections`](../../infra/fly/README.md#database-connections). This
doc records _why_ transaction-pooling mode is the right one, what that mode breaks, and the
`SET LOCAL` convention every caller must follow because of it — the pooler cannot enforce how
application code talks to it. The PgBouncer vocabulary below applies to any transaction-mode pooler.

## Why transaction mode, not session or statement mode

PgBouncer has three pooling modes. The difference is _when_ a server (Postgres-side) connection is
returned to the pool:

| Mode          | Server connection returned to the pool | Multiplexing                                                                                                                     |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `session`     | On client disconnect                   | None beyond skipping TCP/TLS handshake cost — every client still pins one server connection for its whole session.               |
| `transaction` | On transaction commit/rollback         | High — many clients share few server connections, as long as none holds one open between transactions.                           |
| `statement`   | After every statement                  | Highest, but forbids multi-statement transactions outright — incompatible with any ORM that wraps a request in `BEGIN`/`COMMIT`. |

The actual constraint this pooler exists to relieve is Postgres's `max_connections` — a fixed budget of
Postgres backend processes, not a network/TLS-handshake cost. Session mode doesn't touch that
constraint at all: a client that holds a connection idle between requests still occupies a backend
process the whole time. `statement` mode is a non-starter for `apps/api`'s ORM, which wraps request
handlers in transactions. `transaction` is the only mode that actually shrinks the backend-process
footprint under real load.

## What transaction mode breaks

A server connection under `transaction` mode is handed to a **different logical client** the
moment the current one commits or rolls back. Anything that client left on that connection —
session state, not transaction state — leaks to whoever gets it next, or silently vanishes. In
order of how often application code actually hits these:

| Feature                                                                      | Why it breaks                                                                                                                                                                                                | What to do instead                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SET <param> = ...`                                                          | Persists on the physical connection past commit — the _next_ client to get that connection inherits it, silently.                                                                                            | `SET LOCAL <param> = ...` — see below.                                                                                                                                                 |
| `pg_advisory_lock` / `pg_advisory_unlock`                                    | Session-scoped: tied to the connection, not the transaction. A pooled connection can be handed to another client while the lock is still "held" from the first client's perspective.                         | `pg_advisory_xact_lock` — releases automatically at commit/rollback, exactly matching when the pooler returns the connection.                                                          |
| `LISTEN` / `NOTIFY`                                                          | `LISTEN` registers a subscription on one specific backend connection. Under transaction pooling that connection is returned to the pool the moment the transaction ends, silently dropping the subscription. | Bypass the pooler entirely for anything using `LISTEN`/`NOTIFY` — connect straight to Postgres (Supabase's direct connection, port 5432, as migrations do).                            |
| `CREATE TEMP TABLE`                                                          | Temp tables are session-scoped. The table (or a naming collision) leaks into whatever client the connection goes to next.                                                                                    | Avoid temp tables under the pooled path, or issue `ON COMMIT DROP` and never rely on the table surviving past the transaction that created it — and even then, prefer the direct path. |
| Named/server-side prepared statements                                        | Prepared on one physical connection; the client has no guarantee of reconnecting to the same one for a later `EXECUTE`.                                                                                      | Let the driver use unnamed statements: every pool in this repo already runs with `prepare: false` (`infra/fly/README.md`).                                                             |
| `CREATE INDEX CONCURRENTLY` and other DDL requiring session-level guarantees | Needs a connection that isn't reused mid-operation by another client, and some DDL simply can't run pooled correctly.                                                                                        | Run migrations over the direct connection, not through the pooler (`infra/fly/migrate.toml` does).                                                                                     |
| Connection reset between transactions                                        | A transaction-mode pooler does **not** run `DISCARD ALL` between transactions — nothing resets session state for you.                                                                                        | Don't rely on the connection coming back "clean"; the items above are the actual list of what can leak.                                                                                |

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
That is not a coincidental match with the pooler's transaction-mode handoff point — it's the same
boundary. `SET` (without `LOCAL`) has session scope, which under transaction pooling means "until
some other client's transaction happens to run on this same physical connection," which is not a
guarantee any application should build on. If `apps/api`'s ORM issues a bare `SET` anywhere
(connection-level configuration hooks are the usual culprit), it must be changed to `SET LOCAL`
before that code path is allowed to run through the pooler.

## Auth and TLS

Services log in to the pooler as `postgres.<project ref>` (`DATABASE_USER`), verified against
Supabase's root CA (`DATABASE_SSL_MODE = "verify-full"`, `DATABASE_CA_CERT`); see
[`infra/fly/README.md#database-connections`](../../infra/fly/README.md#database-connections). Every
service authenticates as the same `postgres` user (no per-service Postgres role exists yet —
`postgres-conventions.md`'s "Known gaps").

## Known gaps

- **No per-service Postgres role.** Every service authenticates as Supabase's `postgres` user;
  least-privilege per-service roles are the open follow-up in
  `docs/security/S-01-database-role-verification.md`.
- **No alerting on pool saturation.** No alert is defined on the pooler's client wait queue; the
  pooler's own metrics are in the Supabase dashboard.

## Out of scope: indexing and normalization

The pooler is a connection-routing layer — it has no effect on query plans, index usage, or schema
normalization. Index design and normalization belong to whoever owns the schema itself
(`db/migrations`, `docs/database/migration-policy.md`) — noted here only so this doc doesn't silently skip
a question it was asked, not because there's anything pooling-specific to say about it.
