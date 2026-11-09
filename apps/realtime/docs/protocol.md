# Realtime protocol

How a client connects to the realtime gateway, how rooms are named and joined, and the shape of
every message that crosses the wire. The types referenced below are defined in
[`src/protocol.ts`](../src/protocol.ts); this document is the narrative spec, `protocol.ts` is the
source of truth.

## Handshake

```
GET /api/realtime/ticket            (apps/api, Authorization: Bearer <access token>)
  → 200 { "ticket": "<ticket>", "expires_at": "…" }

GET /ws?ticket=<ticket> HTTP/1.1    (this gateway)
Upgrade: websocket
```

A client never sends its access token to the gateway. It asks the API for a **handshake ticket**
(see [Handshake ticket](#handshake-ticket)) on every connection attempt and passes that as the
`ticket` query parameter. A query parameter, not a header, because browsers cannot set arbitrary
headers on a WebSocket handshake. That puts the ticket in load-balancer access logs, which is
acceptable because it is single-use and expires in 30 seconds. The retired `?token=` parameter is
ignored, so a session token sent there gets `TOKEN_MISSING`.

The gateway checks, in order, **before** upgrading:

| Outcome                                                             | Response                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Origin` not in `WS_ALLOWED_ORIGINS`                                | `403 { "error": "origin not allowed", "code": "ORIGIN_NOT_ALLOWED" }`        |
| Missing `ticket`                                                    | `401 { "error": "missing ticket query parameter", "code": "TOKEN_MISSING" }` |
| Ticket or session expired                                           | `401 { "error": "<reason>", "code": "TOKEN_EXPIRED" }`                       |
| Malformed, mis-signed, wrong `aud`/`iss`, lifetime > 60 s, bad role | `401 { "error": "<reason>", "code": "TOKEN_INVALID" }`                       |
| Ticket already used                                                 | `401 { "error": "ticket already used", "code": "TOKEN_INVALID" }`            |
| Session revoked                                                     | `401 { "error": "session revoked", "code": "TOKEN_INVALID" }`                |
| Session check unavailable (Redis down)                              | `503 { "error": "session check unavailable", "code": "UNAVAILABLE" }`        |
| Valid                                                               | `101 Switching Protocols`, connection upgrades                               |

`code` is what a client should branch on, not the free-text `error` (which is for logs). The codes
keep their `TOKEN_` names from the previous handshake. `TOKEN_EXPIRED` means get a fresh ticket and
retry. `TOKEN_MISSING` / `TOKEN_INVALID` mean that ticket will never work. In practice a browser
cannot read the status of a refused handshake, so the clients simply fetch a new ticket per
attempt and give up after a few refusals in a row.

On a successful upgrade the connection is automatically joined to its **home rooms**, all derived
from the ticket's claims:

| Room                              | Membership                                                |
| --------------------------------- | --------------------------------------------------------- |
| `school:{schoolId}`               | every connection for the tenant, regardless of role       |
| `school:{schoolId}:role:{role}`   | one per role the session holds, within the tenant         |
| `school:{schoolId}:user:{userId}` | this user's connection(s) — for direct, targeted delivery |

The gateway sends one `system.joined` message per room, immediately after upgrading.

### Handshake ticket

The contract between `apps/api` (issuer, `src/modules/realtime/ticket.ts`) and this gateway
(verifier, [`src/auth.ts`](../src/auth.ts)) (F-05, QA-14). Its constants are `REALTIME_TICKET` in
`@studafy/constants`, and `apps/api/tests/realtime/ticket-contract.test.ts` runs the real issuer
against the real verifier.

- **Format:** a JWT, `alg: HS256`. Any other `alg` is refused.
- **Key:** `WS_JWT_SECRET`, read by both services from Secrets Manager. Terraform generates it once
  and writes the same value into the realtime and api app secrets (`infra/terraform/main.tf`).
  Both services refuse to start in production with the development default or a key under 32
  characters.
- **Why not the API's JWKS:** the API generates its RSA signing keys in memory, per task, so a
  JWKS fetched through the load balancer can come from a different task than the one that signed
  the ticket. A shared key has no such window and no network call at handshake time.
- **Lifetime:** minted for 30 s. The gateway refuses `exp - iat > 60`, an `iat` more than 5 s in
  the future, and an `exp` in the past. The ticket's `exp` bounds the handshake only; the socket's
  life is bounded by `sexp` (below).
- **Single use:** the gateway records each `jti` in Redis (`realtime:ticket:used:{jti}`, `SET NX`,
  expiring with the ticket) and refuses a second handshake with it.

| Claim       | Type                          | Meaning                                                                    |
| ----------- | ----------------------------- | -------------------------------------------------------------------------- |
| `iss`       | `"studafy-api"`               | issuer                                                                     |
| `aud`       | `"studafy-realtime"`          | this gateway only; the API's access tokens carry another audience and fail |
| `sub`       | string                        | user id                                                                    |
| `school_id` | string                        | tenant boundary — see [rooms](#rooms)                                      |
| `roles`     | non-empty array of `ROLES`    | every role the session holds; one role room each                           |
| `sid`       | string                        | the session's access-token `jti`, which the API denylists on revocation    |
| `sexp`      | number (seconds since epoch)  | the access token's `exp`: the socket closes then                           |
| `jti`       | string                        | this ticket's id, spent at handshake                                       |
| `iat`/`exp` | numbers (seconds since epoch) | issue time and ticket expiry                                               |

The API mints a ticket only behind its normal JWT boundary, so the session is valid, unrevoked and
on current entitlements at that moment. Neither service logs the ticket: the gateway's tracing
records the route, not the URL, and no handshake error echoes it.

### Re-auth protocol

A ticket only proves the session was valid _at handshake time_. Two mechanisms keep the socket
from outliving it:

1. **Expiry.** A timer fires at `sexp`. The gateway sends
   `{ "type": "system.reauth_required", "reason": "session expired" }` and closes with **`4401`**.
2. **Revocation.** Every 15 s (`REVOCATION_SWEEP_INTERVAL_MS`, `src/session-guard.ts`) the gateway
   looks up every open socket's `sid` in the API's access-token denylist
   (`auth:jti:denylist:{jti}`, one `MGET` per 500 sessions). A revoked session's sockets get
   `system.reauth_required` with reason `"session revoked"` and close with **`4401`**. **Bound: a
   revoked session's sockets close within 15 s of the API writing the denylist entry**, plus one
   Redis round trip. A failed sweep is reported and retried on the next tick, so revocation is late
   during a Redis outage, never skipped. The denylist lives in the API's Redis database, which is
   why the gateway has `AUTH_REDIS_URL` separate from its pub/sub `REDIS_URL`.

After a `4401` the client fetches a fresh ticket and reconnects; there is no in-place swap. If the
session is gone, the ticket request itself answers 401 and the client stops. Any close code other
than `4401` is not part of this protocol.

Known gap: when refresh-token reuse is detected, the API revokes the family but does not denylist
its access token (F-08, QA-21), so a socket opened with that session lives until `sexp`
(≤ 15 minutes).

## Rooms

A room key has one of three shapes, all sharing the `school:{schoolId}` prefix — the multi-tenancy
boundary (`src/protocol.ts`'s `parseRoomKeyParts` is the only place this grammar is parsed;
`src/rooms.ts`'s `schoolRoomKey` / `roleRoomKey` / `userRoomKey` are the only places it's built):

| Shape                             | Meaning                                                       |
| --------------------------------- | ------------------------------------------------------------- |
| `school:{schoolId}`               | every connection for the tenant, regardless of role           |
| `school:{schoolId}:role:{ROLE}`   | every connection with that role, within the tenant            |
| `school:{schoolId}:user:{userId}` | a single user's connection(s) — for direct, targeted delivery |

**Who may join or leave which room is decided per room kind** (F-04), by the policy table in
[`src/room-policy.ts`](../src/room-policy.ts). Every kind first requires the room's `schoolId` to
be the caller's own (the tenant-isolation boundary — see `src/app.ws.test.ts`'s probe tests), then
adds its own rule:

| Kind     | Allowed when                                                   | Denied with                                  |
| -------- | -------------------------------------------------------------- | -------------------------------------------- |
| `school` | the room is the caller's school                                | `cannot join a room outside your own school` |
| `role`   | same school **and** the room's role is in the ticket's `roles` | `not authorized for this room`               |
| `user`   | same school **and** the room's user is the ticket's `sub`      | `not authorized for this room`               |
| other    | never — a kind with no row in the table is denied              | `unknown room kind` (or a schema error)      |

So a student cannot subscribe to `school:S:role:INSTRUCTOR`, and no one can subscribe to another
user's `school:S:user:V` room. In practice the policy allows exactly the three home rooms; a new
room kind (e.g. a class room) must add a row to the table to be joinable at all.

Every connection auto-joins all three of its home rooms at handshake. It can leave a room and join
it again, subject to the policy above, with a control message:

```json
{ "type": "join", "room": "school:123:role:INSTRUCTOR" }
{ "type": "leave", "room": "school:123:role:INSTRUCTOR" }
```

The gateway acks with a system message (`system.joined` / `system.left`), or `system.error` if the
room is malformed or the policy denies it.

## Limits

Per-connection limits (F-16), defined in [`src/limits.ts`](../src/limits.ts):

| Limit              | Value                                  | When exceeded                                                                                      |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Frame size         | 16 KB (`maxPayloadLength`)             | Bun drops the connection before any handler runs (the client sees close code 1006 or 1009).        |
| Rooms per socket   | 8, home rooms included                 | The `join` is refused with `system.error` `room limit reached`; re-joining a current room is fine. |
| Client frame rate  | burst of 20, refilled at 2 per second  | `system.error` `rate limit exceeded`, then close code **1008**. Every frame counts, valid or not.  |
| Handshake `Origin` | `WS_ALLOWED_ORIGINS` (comma-separated) | `403 ORIGIN_NOT_ALLOWED` before the ticket is read.                                                |

The Origin allowlist is required when `NODE_ENV=production` (the ECS task sets it to the tier's
`WEB_ORIGIN`); unset in development turns the check off. A handshake **without** an `Origin` header
is accepted: browsers always send one on a WebSocket handshake, so its absence means a non-browser
client such as the mobile app, which cross-site WebSocket hijacking cannot come from.

## Message envelopes

Three distinct message shapes cross the wire; they are never mixed into one schema because they
mean different things (control-plane ack vs. domain event) and grow independently.

### 1. Client -> gateway: control messages (`ClientMessage`)

```json
{ "type": "join", "room": "school:123:role:STUDENT" }
{ "type": "leave", "room": "school:123:role:STUDENT" }
```

### 2. Gateway -> client: system acks/errors (`SystemMessage`)

```json
{ "type": "system.joined", "room": "school:123:role:STUDENT" }
{ "type": "system.left", "room": "school:123:role:STUDENT" }
{ "type": "system.error", "message": "not authorized for this room" }
{ "type": "system.reauth_required", "reason": "session expired" }
```

`system.reauth_required` always precedes a `4401` close — see [Re-auth
protocol](#re-auth-protocol).

### 3. Redis -> gateway -> room members: the event envelope (`EventEnvelope`)

This is what a publisher (e.g. `apps/api`, `apps/workers`) writes to Redis and what every member of
the target room receives verbatim:

```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "type": "announcement.posted",
  "room": "school:123:role:STUDENT",
  "payload": { "text": "Midterm moved to Friday" },
  "publishedAt": "2026-07-09T12:00:00.000Z"
}
```

| Field         | Type               | Meaning                                                                                                        |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `id`          | UUID               | unique per publish, for dedup/logging on the consumer side                                                     |
| `type`        | string             | domain event name — free string at the schema level; see [`type` and `DOMAIN_EVENTS`](#type-and-domain_events) |
| `room`        | room key           | must equal the Redis channel it was published on (enforced, see below)                                         |
| `payload`     | arbitrary JSON     | event-specific data; the gateway does not interpret it                                                         |
| `publishedAt` | ISO-8601 date-time | when the publisher produced the event                                                                          |

#### `type` and `DOMAIN_EVENTS`

`@studafy/constants` defines a `DOMAIN_EVENTS` enum for the rest of the platform. `type` stays a
free string at the schema level (`eventEnvelopeSchema`) rather than a `DomainEvent` union, because
the gateway also fans out direct room-channel publishes whose `type` isn't necessarily a domain
event (see [Redis wiring](#redis-wiring) below). The first real publisher has since landed: the
outbox-relay bridge (`src/outbox-fanout.ts`) constrains its own envelopes to a fixed, explicitly
registered subset of `DOMAIN_EVENTS` — see [`docs/event-routing.md`](event-routing.md) for that
routing table and the payload-is-ids-only contract it depends on.

## Redis wiring

Two independent Redis pub/sub connections feed the same in-memory room broadcast
(`src/index.ts`'s `broadcast`), because a subscribed ioredis client can only run pub/sub commands
and each connection's pattern subscriptions would otherwise have to filter the other's messages
off the same `"pmessage"` event stream:

1. **Direct room publish** (`src/subscriber.ts`) — **channel name = room key.** A publisher does
   `PUBLISH school:123:role:STUDENT <envelope JSON>` (or the bare `school:123` / `school:123:user:456`
   channel); there is no separate channel-naming scheme to keep in sync with room keys. One
   `PSUBSCRIBE school:*` at startup, rather than subscribing/unsubscribing per room as clients join
   and leave — Redis's glob `*` spans `:` like any other character, so this one pattern covers all
   three room kinds, and a single subscription means fan-out delivery never races a room's
   membership changes, since the gateway is always listening on every room's channel and
   `src/rooms.ts`'s in-memory membership map is what decides who actually receives a message.
   Every message is parsed and validated against `eventEnvelopeSchema`, and its `room` field is
   checked against the channel it arrived on; a message that fails either check is logged and
   dropped rather than reaching a client.
2. **Outbox-relayed events** (`src/outbox-fanout.ts`) — bridges `apps/workers`' outbox relay,
   which publishes to `events:{schoolId}:{event_name}` with a raw, envelope-less payload (see
   [`docs/event-routing.md`](event-routing.md)). One `PSUBSCRIBE events:*:{event_name}` per
   registered route; an event with no route is never subscribed to, so it's never received at all.
   `src/outbox-fanout.ts` is what builds the `EventEnvelope` for these — one per target room, with
   a fresh `id` and `publishedAt` — since the outbox relay never wraps its publish in one.

## Example flow

1. Client gets a ticket from `GET /api/realtime/ticket` and connects:
   `GET /ws?ticket=<ticket for sub=user-1, school_id=123, roles=[STUDENT]>`.
2. Gateway verifies and spends the ticket, upgrades, joins the connection to `school:123`,
   `school:123:role:STUDENT`, and `school:123:user:user-1`, sending a `system.joined` for each.
3. `apps/api` (or any publisher) runs `PUBLISH school:123:role:STUDENT '{"id":"...","type":"announcement.posted","room":"school:123:role:STUDENT","payload":{...},"publishedAt":"..."}'`.
4. The gateway's subscriber receives it on the pattern subscription, validates it, and sends the
   envelope verbatim to every member of `school:123:role:STUDENT` — including the client from
   step 1.
5. Later, that session's access token reaches its `exp` (or the session is revoked). The gateway
   sends `system.reauth_required` and closes the socket with code `4401`. The client fetches a
   fresh ticket and repeats step 1.
