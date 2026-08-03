# Event routing table

How an outbox-relayed domain event becomes a room fan-out. `src/event-routing.ts` is the source of
truth; this document is the narrative table. See [`docs/protocol.md`](protocol.md) for room naming
and the `EventEnvelope` shape this feeds into.

## Where events come from

`apps/workers`' outbox relay (`apps/workers/src/queues/outbox-relay/relay.ts`) publishes every
claimed `app.outbox_events` row to a plain Redis pub/sub channel:

```
PUBLISH events:{schoolId}:{event_name} <raw outbox row payload, no envelope>
```

`schoolId` and `event_name` live only in the channel name; the message body is the row's payload
exactly as the emitting transaction wrote it (see `apps/api/src/lib/events/schemas.ts` for the
per-event payload schemas). This is a different channel namespace and message shape from the
gateway's own `school:{schoolId}:role:{ROLE}` room channels (`docs/protocol.md`) — `src/outbox-
fanout.ts` is the bridge between the two.

## How a route is registered

`src/event-routing.ts`'s `EVENT_ROUTES` maps a `DomainEvent` (`@studafy/constants`) to a function
`(schoolId: string) => RoomKey[]`. `src/outbox-fanout.ts` issues one `PSUBSCRIBE
events:*:{event_name}` per routed name — an event with no entry is never subscribed to, so it never
reaches the gateway at all, rather than arriving and being dropped.

**Adding a route is a two-step contract, not just a code change:**

1. Confirm the event's outbox payload schema (`apps/api/src/lib/events/schemas.ts`) carries only
   resource ids — no names, amounts, or other row data. The gateway does not redact or reshape the
   payload; it forwards it unchanged into the `EventEnvelope`, so this guarantee has to hold at the
   source.
2. Add an entry to `EVENT_ROUTES`. Rooms are role-wide broadcast within the event's school — the
   gateway's only room dimension is `school:{schoolId}:role:{ROLE}` — so a route picks which roles
   in that school should hear about it, not which individual users. A client is expected to filter
   for itself using the resource ids in the payload (e.g. a STUDENT client checks the event's
   `studentId` against its own).

## Current routes

| Domain event       | Target rooms                                    | Payload (ids only)                                           |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| `grades.published` | `school:{schoolId}:role:STUDENT`, `role:PARENT` | `{ submissionId, gradebookId, studentId, approvedByUserId }` |

## Known limitation: role-wide broadcast, not per-recipient delivery

Every STUDENT (or PARENT) connection in the school receives every routed event for that school —
the room model has no per-user granularity. This is coarser than how `apps/workers`' notification
recipient resolvers target recipients (e.g. `resolveGradeRecipients` in
`apps/workers/src/queues/notifications/resolvers/recipient.resolver.ts`, which joins to the exact
student/parent rows). It is deliberate for this ticket: the room model's one dimension is
`school:{schoolId}:role:{ROLE}` (`docs/protocol.md`), and adding per-user rooms is a larger change
with no concrete requirement driving it yet. Acceptable because the payload carries only ids — a
client that isn't the intended recipient can discard the message client-side without having seen
any data it shouldn't. If a future event needs precise per-recipient delivery, that's a reason to
revisit the room model, not to work around it here.
