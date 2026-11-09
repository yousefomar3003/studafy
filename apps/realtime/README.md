# @studafy/realtime

Bun + [Hono](https://hono.dev) WebSocket gateway for Studafy. It authenticates a connection with a
single-use handshake ticket minted by `apps/api` (`GET /api/realtime/ticket`), joins it to its home
rooms (`school:{schoolId}`, one `school:{schoolId}:role:{role}` per role,
`school:{schoolId}:user:{userId}`), and fans out messages published to Redis — both direct room
publishes and outbox-relayed domain events — to every member of the target room. A connection whose
session expires or is revoked is warned and closed (re-auth protocol).

See [`docs/protocol.md`](docs/protocol.md) for the full protocol spec (handshake, room naming,
message envelopes, Redis wiring), and [`docs/event-routing.md`](docs/event-routing.md) for which
domain events fan out to which rooms.

## Routes

| Method | Path       | Purpose             | Response                                                                          |
| ------ | ---------- | ------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/healthz` | Liveness            | `200 { "status": "ok" }` while the process is alive                               |
| `GET`  | `/readyz`  | Readiness           | `200 { "status": "ready" }`, or `503 { "status": "shutting_down" }`               |
| `GET`  | `/metrics` | Fan-out counters    | `200` JSON snapshot of `src/metrics.ts` (`received`, `roomDeliveries`, `dropped`) |
| `GET`  | `/ws`      | WebSocket handshake | `101` upgrade on a valid `?ticket=`, `401`/`403`/`503` otherwise                  |

## Architecture

- [`src/env.ts`](src/env.ts) — validates the environment once at startup (fail fast, mirrors
  `apps/api`/`apps/workers`).
- [`src/auth.ts`](src/auth.ts) — verifies handshake tickets (HS256, `WS_JWT_SECRET`, audience and
  lifetime checks); the contract is [`docs/protocol.md`](docs/protocol.md#handshake-ticket).
  `TokenVerificationError` carries a `code` (`TOKEN_EXPIRED` vs `TOKEN_INVALID`) that drives the
  re-auth protocol. `signToken` exists for tests and the smoke test only.
- [`src/session-guard.ts`](src/session-guard.ts) — spends each ticket once and checks the API's
  denylist at handshake; the revocation sweep that closes revoked sessions' sockets every 15 s.
- [`src/protocol.ts`](src/protocol.ts) — `parseRoomKeyParts` (the room key grammar, three kinds:
  school/role/user) and the four Zod-validated message shapes (`ClientMessage`, `SystemMessage`,
  `EventEnvelope`, plus `REAUTH_REQUIRED_CLOSE_CODE`).
- [`src/rooms.ts`](src/rooms.ts) — `schoolRoomKey`/`roleRoomKey`/`userRoomKey`/`parseRoomKey` (the
  room-naming convention) and `createRoomManager`, an in-memory, framework-agnostic membership map.
- [`src/connection.ts`](src/connection.ts) — the Redis connection factory for the pub/sub
  subscribers (one instance per subscriber — see `src/index.ts`).
- [`src/subscriber.ts`](src/subscriber.ts) — `subscribeToRooms`: one `PSUBSCRIBE school:*`,
  validates each message, forwards it to a caller-supplied handler.
- [`src/event-routing.ts`](src/event-routing.ts) — `EVENT_ROUTES`: which rooms an outbox-relayed
  domain event fans out to, given its school. Narrative table in
  [`docs/event-routing.md`](docs/event-routing.md).
- [`src/outbox-fanout.ts`](src/outbox-fanout.ts) — `subscribeToOutboxEvents`: bridges
  `apps/workers`' outbox-relay Redis channels (`events:{schoolId}:{event_name}`) into
  `EventEnvelope`s for the routes in `src/event-routing.ts`.
- [`src/metrics.ts`](src/metrics.ts) — in-process fan-out counters, exposed via `GET /metrics`.
- [`src/health.ts`](src/health.ts) — liveness/readiness/metrics routes, mirrors `apps/api`.
- [`src/app.ts`](src/app.ts) — the Hono app: health routes plus the `/ws` handshake and connection
  handlers (join all three home rooms on open, schedule the re-auth timer, handle `join`/`leave`
  control messages, leave all rooms on close).
- [`src/lifecycle.ts`](src/lifecycle.ts) — `createConnectionTracker` and `gracefulShutdown`.
- [`src/index.ts`](src/index.ts) — process entrypoint: loads env, opens both Redis subscribers
  (rooms and outbox events), wires both to room broadcast, starts `Bun.serve`, wires
  `SIGTERM`/`SIGINT`.

## Environment

| Variable         | Type                                    | Default                         | Notes                                                                             |
| ---------------- | --------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `NODE_ENV`       | `development` \| `test` \| `production` | `development`                   |                                                                                   |
| `PORT`           | integer `1`–`65535`                     | `3001`                          |                                                                                   |
| `HOST`           | string                                  | `0.0.0.0`                       | interface to bind                                                                 |
| `REDIS_URL`      | string                                  | `redis://localhost:6379`        | pub/sub subscriber connection                                                     |
| `AUTH_REDIS_URL` | string                                  | `REDIS_URL`                     | the API's auth database (denylist, spent tickets); required in production         |
| `WS_JWT_SECRET`  | string                                  | `dev-insecure-secret-change-me` | ticket key, shared with `apps/api`; production refuses the default and < 32 chars |

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
most of `src/app.test.ts`) doesn't provide one, so a real upgrade can't be driven that way. It
_can_ be driven by starting a real `Bun.serve` inside a `bun test` file, though, and that needs no
Redis — only the fan-out step does. So the split is by Redis dependency, not by "real socket or
not":

- `bun test` covers everything that doesn't require Redis, including real WebSocket upgrades:
  env validation, ticket verification, protocol schemas, room membership, the Redis message
  subscriber (against a fake emitter), the handshake's _rejection_ path (missing/invalid/expired
  ticket — those return a plain HTTP 401 before ever reaching the upgrade), and — in
  [`src/app.ws.test.ts`](src/app.ws.test.ts), against a real `Bun.serve` with an in-memory session
  guard — the cross-tenant room probe tests, ticket replay, revocation, and the re-auth close. The
  API↔gateway contract is in `apps/api/tests/realtime/ticket-contract.test.ts`. These run in CI on
  every push.
- `scripts/smoke-test.ts` covers what's left: a real Redis `PUBLISH` fanning out to the right room
  members (and _not_ to a client in a different school). This mirrors `apps/workers`' split
  between its unit tests and its Redis-required `smoke-test.ts`.

## Graceful shutdown

On `SIGTERM`/`SIGINT` the gateway marks itself not-ready, stops the Redis pattern subscription
(`PUNSUBSCRIBE`), and closes every open connection (code `1001`, "server shutting down"). Unlike
`apps/api`'s request draining or `apps/workers`' job draining, there is no per-connection
asynchronous work to wait for — sending a close frame is effectively immediate — so shutdown here
is unconditional rather than timeout-bounded. See the module doc in
[`src/lifecycle.ts`](src/lifecycle.ts) for the full reasoning.
