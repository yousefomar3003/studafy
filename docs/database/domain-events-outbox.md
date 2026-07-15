# Domain events outbox

Migration `000022_create_outbox_events_table.sql` adds one school-owned table under the `app`
schema: `outbox_events`. SQL constraints are the source of truth; APIs must not weaken them or
treat RLS as a substitute for permission checks.

## What it is

A classic transactional outbox for Studafy's own domain events (`DOMAIN_EVENTS` in
[`packages/constants/src/events.ts`](../../packages/constants/src/events.ts)), relayed to the
`outbox-relay` BullMQ queue documented in
[`apps/workers/docs/queue-catalog.md`](../../apps/workers/docs/queue-catalog.md). The transaction
that performs a domain write (creating a user, publishing an assignment, issuing a certificate,
...) inserts the matching `outbox_events` row in the same transaction, so the fact and its event
either both commit or both roll back -- there is no dual-write race between "did the write happen"
and "was the event recorded to be published."

This is a narrower table than `finance_sync_outbox`
([`docs/database/finance-data-model.md`](./finance-data-model.md)), not a generalization of it:
`finance_sync_outbox` is a retryable outbound command queue to one external system (ERPNext) with
its own delivery-state machine (`status`, `attempts`, `available_at`, `last_error`).
`outbox_events` answers exactly one question per row -- was this event ever relayed -- and carries
no retry/backoff state; a failed downstream delivery is the BullMQ consumer's retry concern, not a
second state machine duplicated into the database.

## Schema

| Column       | Type          | Notes                                                                     |
| ------------ | ------------- | ------------------------------------------------------------------------- |
| `id`         | `bigint`      | Ordered identity; relay order is the load-bearing property.               |
| `school_id`  | `uuid`        | `NOT NULL`; foreign key to `app.schools (id)`, `RESTRICT`/`RESTRICT`.     |
| `event_name` | `text`        | `NOT NULL`; must match `DOMAIN_EVENTS`' `resource.pastTenseAction` shape. |
| `payload`    | `jsonb`       | `NOT NULL`; the event body, opaque to this table.                         |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT CURRENT_TIMESTAMP`.                                     |
| `relayed_at` | `timestamptz` | `NULL` until relayed; `relayed_at >= created_at` when set.                |

Primary/candidate key: `id` (ordered bigint) determines the event's tenant, name, payload, and
relay state. All values are atomic (1NF); the table has no composite key, so 2NF is trivial;
`event_name` and `payload` depend only on the row's own identity, not on any other table's data
(3NF). There is deliberately no `updated_at` -- `relayed_at` is the only mutation a row ever
undergoes, so a second "last changed" column would just duplicate it.

## RLS and grants

Owned by `studafy_admin`, grants only CRUD to `studafy_app`, revokes table access from `PUBLIC`,
and carries the canonical permissive `FOR ALL TO PUBLIC` `tenant_isolation` policy
(`app.apply_tenant_isolation`) with both RLS flags enabled and forced -- this repo's uniform
treatment for every tenant-scoped table. There is no `BYPASSRLS` role
(`db/migrations/000002_create_database_roles_and_grants.sql`), so, like `finance_sync_outbox`, a
relay worker processes one school at a time, setting `app.school_id` before each tenant's claim
batch.

## Concurrency: exactly-once relay

Relay workers claim unrelayed rows with a `SELECT ... FOR UPDATE SKIP LOCKED` scan, then mark them
relayed in the same transaction as the claim:

```sql
BEGIN;
SELECT set_config('app.school_id', $1, true);

WITH claimed AS (
  SELECT id FROM app.outbox_events
  WHERE school_id = $1 AND relayed_at IS NULL
  ORDER BY id
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE app.outbox_events
SET relayed_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT id FROM claimed)
RETURNING id, event_name, payload;

COMMIT;
```

`SKIP LOCKED` means two concurrent relayer instances scanning the same tenant never claim the same
row: whichever transaction locks a row first, the other skips it and moves to the next candidate,
so every row is marked relayed by exactly one relayer, even under concurrent relayers (verified in
`packages/db/tests/outbox-events.test.ts`).

## Index rationale

`idx_outbox_events_school_unrelayed` (partial, `WHERE relayed_at IS NULL`, columns `(school_id,
id)`) backs the relay worker's only query -- the next unrelayed rows for one tenant, oldest first.
It is the sole documented access pattern, so no other index is added. A plain (non-partial) index
on `school_id` to speed `app.schools`' `ON DELETE`/`UPDATE RESTRICT` check was considered and
rejected as speculative: schools are administrative rows that are essentially never deleted or
renumbered (every foreign key to `app.schools` in this schema is `RESTRICT`, never `CASCADE`), so
paying write amplification on every insert and relay-mark to speed a check that in practice never
runs is not a demonstrated need.

## Known gaps

- No per-row retry/backoff/poison state. A relayed row is done; a row that fails downstream after
  being claimed is the BullMQ job's own retry/dead-letter concern (`outbox-relay` queue,
  `apps/workers/src/registry.ts`), not something this table re-implements.
- No pruning/retention job. Relayed rows accumulate until an operational decision is made about
  retention; that is a future maintenance ticket (the same shape as
  `docs/database/attendance-partition-maintenance.md`), not part of this migration.
- No `updated_at` or `aggregate_id`/`occurred_at` columns beyond the ticket's own field list
  (`event_name`, `payload`, `school_id`, `created_at`, `relayed_at`). Nothing in the current ticket
  demonstrates a need for them, and inventing columns speculatively is exactly what the
  [normalization standard](./migration-policy.md#normalization-standard) warns against.
