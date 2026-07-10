# @studafy/realtime

Bun + [Hono](https://hono.dev) WebSocket gateway for Studafy. It authenticates a connection with a
JWT handshake stub, joins it to a room (`school:{schoolId}:role:{role}`), and fans out messages
published to Redis to every member of the target room.

See [`docs/protocol.md`](docs/protocol.md) for the full protocol spec (handshake, room naming,
message envelopes, Redis wiring).

## Routes

| Method | Path       | Purpose             | Response                                                            |
| ------ | ---------- | ------------------- | ------------------------------------------------------------------- |
| `GET`  | `/healthz` | Liveness            | `200 { "status": "ok" }` while the process is alive                 |
| `GET`  | `/readyz`  | Readiness           | `200 { "status": "ready" }`, or `503 { "status": "shutting_down" }` |
| `GET`  | `/ws`      | WebSocket handshake | `101` upgrade on a valid `?token=`, `401` otherwise                 |

## Architecture

- [`src/env.ts`](src/env.ts) — validates the environment once at startup (fail fast, mirrors
  `apps/api`/`apps/workers`).
- [`src/auth.ts`](src/auth.ts) — the JWT handshake stub: HS256 sign/verify against
  `WS_JWT_SECRET`. Documented limitations and the follow-up ticket are in
  [`docs/protocol.md`](docs/protocol.md#jwt-handshake-stub-and-its-limits).
- [`src/protocol.ts`](src/protocol.ts) — the room key format and the three Zod-validated message
  shapes (`ClientMessage`, `SystemMessage`, `EventEnvelope`).
- [`src/rooms.ts`](src/rooms.ts) — `roomKey`/`parseRoomKey` (the room-naming convention) and
  `createRoomManager`, an in-memory, framework-agnostic membership map.
- [`src/connection.ts`](src/connection.ts) — the Redis connection factory for the pub/sub
  subscriber.
- [`src/subscriber.ts`](src/subscriber.ts) — `subscribeToRooms`: one `PSUBSCRIBE
school:*:role:*`, validates each message, forwards it to a caller-supplied handler.
- [`src/health.ts`](src/health.ts) — liveness/readiness routes, mirrors `apps/api`.
- [`src/app.ts`](src/app.ts) — the Hono app: health routes plus the `/ws` handshake and connection
  handlers (join home room on open, handle `join`/`leave` control messages, leave all rooms on
  close).
- [`src/lifecycle.ts`](src/lifecycle.ts) — `createConnectionTracker` and `gracefulShutdown`.
- [`src/index.ts`](src/index.ts) — process entrypoint: loads env, opens the Redis subscriber,
  wires Redis messages to room broadcast, starts `Bun.serve`, wires `SIGTERM`/`SIGINT`.

## Environment

| Variable        | Type                                    | Default                         | Notes                                                                |
| --------------- | --------------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `NODE_ENV`      | `development` \| `test` \| `production` | `development`                   |                                                                      |
| `PORT`          | integer `1`–`65535`                     | `3001`                          |                                                                      |
| `HOST`          | string                                  | `0.0.0.0`                       | interface to bind                                                    |
| `REDIS_URL`     | string                                  | `redis://localhost:6379`        | pub/sub subscriber connection                                        |
| `WS_JWT_SECRET` | string                                  | `dev-insecure-secret-change-me` | HS256 secret for the JWT stub — **must** be overridden in production |

## Commands

```sh
bun run dev          # start with hot reload (bun --watch), requires Redis at REDIS_URL
bun run build        # bundle to dist/
bun run check-types  # tsc --noEmit
bun run lint         # eslint .
bun test             # run the unit test suite (no Redis required)
bun run smoke-test   # end-to-end: real WebSocket clients, real Redis publish, assert room fan-out (requires Redis)
```

### Why the split between `bun test` and `smoke-test`

`hono/bun`'s WebSocket upgrade needs a live `Bun.serve` server object — `app.request()` (used by
`bun test`) doesn't provide one, so a real upgrade can't be driven from a unit test. `bun test`
covers everything that doesn't require an actual socket or Redis: env validation, the JWT stub,
protocol schemas, room membership, the Redis message subscriber (against a fake emitter), and the
handshake's _rejection_ path (missing/invalid/expired token — those return a plain HTTP 401 before
ever reaching the upgrade). `scripts/smoke-test.ts` covers what's left: a real client connecting
with a valid token, joining its home room, an explicit `join` to a second room, and a real Redis
`PUBLISH` fanning out to the right room members (and _not_ to a client in a different school). This
mirrors `apps/workers`' split between its unit tests and its Redis-required `smoke-test.ts`.

## Graceful shutdown

On `SIGTERM`/`SIGINT` the gateway marks itself not-ready, stops the Redis pattern subscription
(`PUNSUBSCRIBE`), and closes every open connection (code `1001`, "server shutting down"). Unlike
`apps/api`'s request draining or `apps/workers`' job draining, there is no per-connection
asynchronous work to wait for — sending a close frame is effectively immediate — so shutdown here
is unconditional rather than timeout-bounded. See the module doc in
[`src/lifecycle.ts`](src/lifecycle.ts) for the full reasoning.
