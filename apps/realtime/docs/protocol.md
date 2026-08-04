# Realtime protocol

How a client connects to the realtime gateway, how rooms are named and joined, and the shape of
every message that crosses the wire. The types referenced below are defined in
[`src/protocol.ts`](../src/protocol.ts); this document is the narrative spec, `protocol.ts` is the
source of truth.

## Handshake

```
GET /ws?token=<jwt> HTTP/1.1
Upgrade: websocket
```

The token is passed as a query parameter, not a header — browsers cannot set arbitrary headers on
a WebSocket handshake request, so a query parameter is the standard way to authenticate one. The
gateway verifies the token (see [JWT stub](#jwt-handshake-stub-and-its-limits) below) **before**
upgrading:

| Outcome                               | Response                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Missing `token`                       | `401 { "error": "missing token query parameter", "code": "TOKEN_MISSING" }` |
| Expired token                         | `401 { "error": "<reason>", "code": "TOKEN_EXPIRED" }`                      |
| Malformed / mis-signed / unknown role | `401 { "error": "<reason>", "code": "TOKEN_INVALID" }`                      |
| Valid token                           | `101 Switching Protocols`, connection upgrades                              |

`code` is what a client should branch on, not the free-text `error` (which is for logs):
`TOKEN_EXPIRED` means the credentials are merely stale — get a fresh token and retry the handshake.
`TOKEN_MISSING` / `TOKEN_INVALID` mean the request itself is broken; retrying with the same token
is pointless. See [Re-auth protocol](#re-auth-protocol) for the full flow, including what happens
when a token expires _after_ a successful upgrade.

On a successful upgrade the connection is automatically joined to three **home rooms**, all
derived from the token's claims:

| Room                              | Membership                                                |
| --------------------------------- | --------------------------------------------------------- |
| `school:{schoolId}`               | every connection for the tenant, regardless of role       |
| `school:{schoolId}:role:{role}`   | every connection with that role, within the tenant        |
| `school:{schoolId}:user:{userId}` | this user's connection(s) — for direct, targeted delivery |

The gateway sends one `system.joined` message per room, immediately after upgrading.

### JWT handshake stub and its limits

There is no identity provider integrated yet, so `src/auth.ts` is both issuer (`signToken`, used
by tests and the smoke test) and verifier (`verifyToken`) of a single HS256 shared secret
(`WS_JWT_SECRET`). It genuinely checks the signature and `exp` — a connection cannot be established
with a token that isn't validly signed by that secret — but it does **not** do issuer/audience
validation, JWKS rotation, or revocation. Replacing it with real auth is out of scope for this
ticket; that ticket should swap `verifyToken`'s secret lookup for JWKS verification against the
real identity provider and delete `signToken`.

Claims (JWT payload):

| Claim      | Type                                  | Required | Meaning                                     |
| ---------- | ------------------------------------- | -------- | ------------------------------------------- |
| `sub`      | string                                | yes      | user id                                     |
| `schoolId` | string                                | yes      | tenant boundary — see [rooms](#rooms)       |
| `role`     | one of `ROLES` (`@studafy/constants`) | yes      | the role the room key's `role` segment uses |
| `exp`      | number (seconds since epoch)          | no       | standard JWT expiry                         |

### Re-auth protocol

`verifyToken` only proves a token was valid _at handshake time_. Without a follow-up mechanism, a
connection that opened with a token carrying `exp` would stay a member of its rooms forever after
that `exp` passes — nothing would ever re-check it. Instead:

1. If the claims carry `exp`, the gateway schedules a timer for exactly that instant. A token with
   no `exp` never expires and gets no timer.
2. When the timer fires, the gateway sends `{ "type": "system.reauth_required", "reason": "token
expired" }`, then closes the socket with close code **`4401`** (reason `"token expired"`).
3. The client is expected to obtain a fresh token (however it does that outside this protocol) and
   reconnect via a normal `GET /ws?token=<new token>` handshake — there is no in-place token swap
   on an existing socket. A reconnect after a `4401` close, or after a `401` with `code:
"TOKEN_EXPIRED"`, is the entire "expired-token reconnect flow": the client is not expected to
   distinguish the two: both mean "the token expired, not the connection request itself, so get a
   new one and retry."
4. A `401` with `code: "TOKEN_MISSING"` or `"TOKEN_INVALID"`, or any WebSocket close code other
   than `4401`, is not part of this protocol — don't retry those with the same token.

## Rooms

A room key has one of three shapes, all sharing the `school:{schoolId}` prefix — the multi-tenancy
boundary (`src/protocol.ts`'s `parseRoomKeyParts` is the only place this grammar is parsed;
`src/rooms.ts`'s `schoolRoomKey` / `roleRoomKey` / `userRoomKey` are the only places it's built):

| Shape                             | Meaning                                                       |
| --------------------------------- | ------------------------------------------------------------- |
| `school:{schoolId}`               | every connection for the tenant, regardless of role           |
| `school:{schoolId}:role:{ROLE}`   | every connection with that role, within the tenant            |
| `school:{schoolId}:user:{userId}` | a single user's connection(s) — for direct, targeted delivery |

**A client may only join or leave rooms within its own `schoolId`** — the gateway rejects a
`join`/`leave` for any other school's room with a `system.error`. This is the tenant-isolation
boundary: it is enforced regardless of room kind, and is what makes cross-tenant room subscription
impossible (see `src/app.ws.test.ts`'s probe tests). It does not further restrict which role's or
user's room a client may join within its own school (e.g. an instructor can subscribe to the
student room in the same school); that is a coarser authorization model than the platform's full
permission matrix (`docs/adr/0002-fixed-roles-authorization.md`) and is a known simplification — a
future ticket can tighten it if a concrete requirement needs to.

Every connection auto-joins all three of its home rooms at handshake. It can join additional rooms
(in the same school) with a control message:

```json
{ "type": "join", "room": "school:123:role:INSTRUCTOR" }
{ "type": "leave", "room": "school:123:role:INSTRUCTOR" }
```

The gateway acks with a system message (`system.joined` / `system.left`), or `system.error` if the
room is malformed or outside the client's school.

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
{ "type": "system.error", "message": "cannot join a room outside your own school" }
{ "type": "system.reauth_required", "reason": "token expired" }
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

1. Client connects: `GET /ws?token=<signed JWT for sub=user-1, schoolId=123, role=STUDENT>`.
2. Gateway verifies the token, upgrades, joins the connection to `school:123`,
   `school:123:role:STUDENT`, and `school:123:user:user-1`, sending a `system.joined` for each.
3. `apps/api` (or any publisher) runs `PUBLISH school:123:role:STUDENT '{"id":"...","type":"announcement.posted","room":"school:123:role:STUDENT","payload":{...},"publishedAt":"..."}'`.
4. The gateway's subscriber receives it on the pattern subscription, validates it, and sends the
   envelope verbatim to every member of `school:123:role:STUDENT` — including the client from
   step 1.
5. Later, that connection's token reaches its `exp`. The gateway sends `system.reauth_required`
   and closes the socket with code `4401`. The client fetches a fresh token and repeats step 1.
