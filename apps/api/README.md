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

## Commands

```sh
bun run dev          # start with hot reload (bun --watch)
bun run build        # bundle to dist/
bun run check-types  # tsc --noEmit
bun run lint         # eslint .
bun test             # run the test suite
```

Quick check once running:

```sh
curl -i localhost:3000/healthz   # 200 {"status":"ok"}
curl -i localhost:3000/readyz    # 200 {"status":"ready"}
```

## Graceful shutdown

On `SIGTERM` or `SIGINT` the server marks itself not-ready, stops accepting new connections, and
waits for in-flight requests to finish (bounded by `SHUTDOWN_TIMEOUT_MS`) before exiting. The
draining logic lives in [`src/lifecycle.ts`](src/lifecycle.ts) and is unit-tested independently of
the network layer.
