# ADR-012: Transactional outbox — one table, relayed exactly once

## Status

Accepted

## Context

Several asynchronous consumers react to state changes Studafy itself originates — notifications
(ST-139), entitlement invalidation (ST-133), digest email, ERPNext sync (000015), and the AI
entitlement publisher. The invariant every one of them needs is: _the event that describes a fact
is written in the same transaction as the fact_, so nobody ever observes the fact without its event
or receives an event whose fact was rolled back. The decision to record is the mechanism, the exact
once/twice semantics, and why the table stays as small as it is.

## Decision

- **A single general-purpose outbox table: `app.outbox_events` (`000022`).** Its entire job is
  "was this domain event, written in the same transaction as the fact it describes, ever relayed".
  Columns: `id bigint identity` (plain ordered bigint, not uuid — relay order is the table's
  load-bearing property), `school_id`, `event_name`, `payload jsonb`, `created_at`, `relayed_at`.
- **Event names are structurally controlled.** `event_name` carries the CHECK
  `event_name ~ '^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$'` (a `resource.pastTense` like `user.created`,
  `assignment.deadlineExtended`), mirroring the `DOMAIN_EVENTS` catalog in
  `packages/constants/src/events.ts`. Because the catalog is the repo's own vocabulary, its shape is
  enforced with a CHECK rather than only trimmed — a name that violates it fails at INSERT, inside
  the very transaction recording the change (see SAD_16 for the two-segment naming rule).
- **Exactly-once claim, at-least-once delivery.** A relay worker claims unrelayed rows for one
  tenant with `SELECT ... WHERE school_id = $1 AND relayed_at IS NULL ORDER BY id FOR UPDATE SKIP
LOCKED LIMIT n`, then marks `relayed_at` on those exact rows in the same transaction
  (`apps/workers/src/queues/outbox-relay/claim.ts`). Two concurrent relayers never claim the same
  row; if the claiming transaction crashes, the locks release and the rows stay unrelayed. A row is
  therefore relayed **at most once**, and a consumer sees each event **at least once**, which is why
  every consumer must be idempotent.
- **Retry/backoff is the queue's job, not the table's.** The relay publishes to the BullMQ
  `outbox-relay` queue, whose own retry policy handles a failed downstream delivery. There is no
  per-row delivery state machine in the table — no `status`, `attempts`, `available_at`,
  `last_error` — because a row that fails downstream is retried by the queue, not re-claimed.
- **This is deliberately a different table from `app.finance_sync_outbox` (000015).** That table is
  a _retryable outbound command queue to one external system_ (ERPNext) and carries its own delivery
  state machine. `outbox_events` is the general Studafy-originated domain-event bus. They are not
  merged and the domain-event table is not generalized to absorb the command queue.
- **The relay is tenant-scoped like everything else.** `outbox_events` is RLS-isolated (000022 calls
  `apply_tenant_isolation`), so a relay claims one school at a time and sets `app.school_id` per
  batch — the same constraint 000015 documents for `finance_sync_outbox`. System-level claims run
  through the SYSTEM scope pattern (ADR-0008/0015) where the GUC is armed per transaction.

## Alternatives considered

- **Dual-write to the message queue at the same time as the database write** — the classic
  dual-write hazard: a commit can succeed while the queue publish fails (or vice-versa) and the two
  permanently disagree. Rejected as the failure mode the outbox exists to remove.
- **Change Data Capture (Debezium / logical replication)** — powerful, but it reads Postgres WAL and
  emits schema-bound changes, which is the wrong shape for our own semantic domain events
  (`assignment.deadlineExtended`), and it adds an external service between write and consume.
  Rejected at this scale; nothing in the repo uses it.
- **Per-aggregate outbox tables** — would multiply the same relay machinery per domain and invite
  each one to evolve its own claim/state conventions. One table with a controlled event-name CHECK
  is the DRY answer; the design note records the same reasoning.
- **Redis/queue as the outbox (write the event to Redis inside the transaction)** — Redis has no
  transaction with Postgres, and a fire-and-forget Redis write is precisely what SAD_16 documents as
  lossy (the durable guarantee is always the DB + polling consumer, never the pub/sub).

## Consequences

- Consumers are written once to be idempotent, because "at-least-once" is the contract — event
  names are the dedup key downstream, not a promise of single delivery.
- Relay throughput is per-tenant (one claim batch per school per cycle), which caps a single scan
  cost at O(#schools) per cycle — the same ceiling SAD_16 records for the email dispatcher; a
  cross-tenant claim path is a separate ticket.
- The table stays at five fields; anyone tempted to add delivery state must first justify why the
  BullMQ consumer's own retry policy is insufficient. A demonstrated need is an expansion migration,
  not something guessed at on day one.

## Review

Reviewed by `baderalhindi` on 2026-09-11.
