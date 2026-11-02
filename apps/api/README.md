# @studafy/api

Minimal, production-ready Bun + [Hono](https://hono.dev) API bootstrap for Studafy. It provides
the process skeleton — environment validation, health probes, and graceful shutdown — that later
tickets build domain routes on top of.

## Routes

| Method | Path       | Purpose   | Response                                                                            |
| ------ | ---------- | --------- | ----------------------------------------------------------------------------------- |
| `GET`  | `/healthz` | Liveness  | `200 { "status": "ok" }` while the process is alive                                 |
| `GET`  | `/readyz`  | Readiness | `200 { "status": "ready" }`, or `503 { "status": "shutting_down" }` during shutdown |

Liveness and readiness are intentionally separate: `/healthz` only reports that the process is
running, while `/readyz` reports whether the app should receive traffic. On `SIGTERM`/`SIGINT`,
`/readyz` flips to `503` first so load balancers stop routing while in-flight requests drain.

## Environment

Validated once at startup by [`src/env.ts`](src/env.ts). An invalid value throws a named
`EnvValidationError` **before** the server binds a port (fail fast).

| Variable              | Type                                    | Default       | Notes                                |
| --------------------- | --------------------------------------- | ------------- | ------------------------------------ |
| `NODE_ENV`            | `development` \| `test` \| `production` | `development` |                                      |
| `PORT`                | integer `1`–`65535`                     | `3000`        |                                      |
| `HOST`                | string                                  | `0.0.0.0`     | interface to bind                    |
| `SHUTDOWN_TIMEOUT_MS` | integer `>= 0`                          | `10000`       | max time to drain in-flight requests |
| `LOG_LEVEL`           | `trace`…`fatal`                         | `info`        | volume knob; below it costs nothing  |
| `SERVICE_NAME`        | string                                  | `api`         | `service` field on every log line    |
| `RELEASE_VERSION`     | string                                  | `unknown`     | `IMAGE_TAG` in deployments           |
| `DATABASE_HOST`       | string                                  | none          | required in production               |
| `DATABASE_PORT`       | integer `1`-`65535`                     | none          | PgBouncer listener                   |
| `DATABASE_NAME`       | string                                  | none          | PgBouncer service pool name          |
| `DATABASE_USER`       | string                                  | none          | injected from Secrets Manager        |
| `DATABASE_PASSWORD`   | string                                  | none          | injected from Secrets Manager        |
| `DATABASE_CA_CERT`    | PEM string                              | none          | verifies PgBouncer TLS               |

The PostgreSQL client disables prepared statements for transaction pooling. In production,
`/readyz` runs `SELECT 1` through PgBouncer before reporting ready.

`RELEASE_VERSION` is deliberately **not** required in production: `unknown` in a log line is a
diagnosable state, whereas a container refusing to boot over a logging field is an outage.

## Logging and request tracing

Every request is assigned a UUIDv4 `request_id`, returned as `X-Request-Id`, bound to a child logger,
and embedded in any `application/problem+json` error body. Logs are pino-shaped NDJSON on stdout.
An inbound `X-Request-Id` is **ignored** — the id keys the audit trail, so it is never client-chosen.

Every failed request carries that envelope, including one no route matched: unmatched paths return
`application/problem+json` with `code: "RESOURCE_NOT_FOUND"`, not Hono's default `text/plain` 404.

Full conventions, the request-to-audit-partition lifecycle, and the list of what does not exist yet
live in [`docs/architecture/SAD_28_logging_conventions.md`](../../docs/architecture/SAD_28_logging_conventions.md).

## Tenant database transactions

Future school-scoped handlers must authenticate the principal, authorize its school membership,
and then wrap all tenant queries with `withTenantTransaction`. The helper assumes the restricted
`studafy_app` role and sets `app.school_id` (and optional `app.user_id`) transaction-locally using the
authorized context rather than a client-provided value. Commit or roll back happens before the
connection returns to PgBouncer. Never use session-level `SET`: transaction pooling can hand that
physical connection to another request and leak its tenant context.

The API currently has no tenant domain handlers or authorization integration, so this README records
the contract for the ticket that adds them; ST-034 implements and tests the database boundary only.

## Commands

```sh
bun run dev          # start with hot reload (bun --watch)
bun run build        # bundle to dist/
bun run check-types  # tsc --noEmit
bun run lint         # eslint .
bun test             # run the test suite
bun run test:security # run the NFR-05 database probe (requires TEST_DATABASE_URL)
```

Quick check once running:

```sh
curl -i localhost:3000/healthz   # 200 {"status":"ok"}, plus an X-Request-Id header
curl -i localhost:3000/readyz    # 200 {"status":"ready"}
```

`bun test` from this directory needs the workspace packages built first (`@studafy/constants` and
`@studafy/shared-schemas` are consumed from `dist/`). `bun run test` from the repository root handles
that ordering for you.

## Graceful shutdown

On `SIGTERM` or `SIGINT` the server marks itself not-ready, stops accepting new connections, and
waits for in-flight requests to finish (bounded by `SHUTDOWN_TIMEOUT_MS`) before exiting. The
draining logic lives in [`src/lifecycle.ts`](src/lifecycle.ts) and is unit-tested independently of
the network layer.
