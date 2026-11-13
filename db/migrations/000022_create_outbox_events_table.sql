-- Creates app.outbox_events, the general-purpose transactional outbox for Studafy-originated
-- domain events (packages/constants/src/events.ts's DOMAIN_EVENTS catalog), relayed to the
-- `outbox-relay` BullMQ queue documented in apps/workers/docs/queue-catalog.md. Depends on 000004
-- (app.schools) for the tenant foreign key and 000006 (app.apply_tenant_isolation) for RLS.
--
-- This is deliberately a different, narrower table than 000015's app.finance_sync_outbox, not a
-- generalization of it: finance_sync_outbox is a retryable outbound command queue to one external
-- system (ERPNext) and carries its own delivery-state machine (status, attempts, available_at,
-- last_error). This table's job is only "was this domain event, written in the same transaction as
-- the fact it describes, ever relayed" -- exactly the five fields the ticket names (event_name,
-- payload, school_id, created_at, relayed_at). A row is relayed at most once and never retried in
-- place; retry/backoff for a failed downstream delivery is the queue consumer's job (BullMQ already
-- has its own retry policy), not a second state machine duplicated into this table. If a future
-- ticket demonstrates a concrete need for per-row delivery status beyond "relayed or not," that is
-- an expansion migration, not something to guess at here.
--
-- Concurrency: relay workers claim unrelayed rows with
--   SELECT id FROM app.outbox_events WHERE school_id = $1 AND relayed_at IS NULL
--     ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
-- then UPDATE ... SET relayed_at = now() WHERE id = ANY(claimed ids), in the same transaction as the
-- claim. SKIP LOCKED means two concurrent relayers scanning the same tenant never claim the same
-- row: whichever transaction locks a row first, the other skips it and moves to the next candidate,
-- so every row is marked relayed by exactly one relayer. This requires the claim and the mark to run
-- in one transaction (a plain UPDATE ... WHERE relayed_at IS NULL RETURNING * without a preceding
-- locking read is also safe on its own -- row locks are still taken row-by-row during the UPDATE --
-- but SKIP LOCKED is only available on a SELECT, hence the two-step claim-then-mark form).
--
-- Like every RLS-bearing table in this schema, there is no BYPASSRLS role
-- (docs/database/role-model.md), so a relay worker processes one school at a time, setting
-- app.school_id before each tenant's claim batch -- the same constraint 000015 documents for
-- finance_sync_outbox.

SET ROLE studafy_admin;

-- id is a plain ordered bigint identity, not a uuid, for the same reason as
-- finance_sync_outbox.id (000015): relay order is this table's load-bearing property, and nothing
-- else references an outbox row by id.
CREATE TABLE app.outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_outbox_events PRIMARY KEY,
  school_id uuid NOT NULL,
  event_name text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  relayed_at timestamptz,
  CONSTRAINT fk_outbox_events_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Matches the `resource.pastTenseAction` shape DOMAIN_EVENTS (packages/constants/src/events.ts)
  -- already uses (e.g. 'user.created', 'assignment.deadlineExtended'). Unlike
  -- app.billing_events.event_type (000016), which accepts any non-empty externally-sourced string
  -- because Stripe owns that vocabulary, this catalog is Studafy's own and this repo's convention
  -- (app.schools.slug, app.plans.code, app.platform_settings.key) is to enforce a structurally
  -- controlled catalog's shape with a CHECK rather than only trimming it.
  CONSTRAINT ck_outbox_events_event_name CHECK (event_name ~ '^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$'),
  CONSTRAINT ck_outbox_events_relayed_at CHECK (relayed_at IS NULL OR relayed_at >= created_at)
);

-- Backs the relay worker's only query: the next unrelayed rows for one tenant, oldest first. This
-- is the sole documented access pattern, so no other index is added. A plain (non-partial) index on
-- school_id to speed app.schools' ON DELETE/UPDATE RESTRICT check was considered and rejected as
-- speculative: schools are administrative rows that are essentially never deleted or have their id
-- changed (every foreign key to app.schools in this schema is RESTRICT, never CASCADE), so paying
-- write amplification on every insert and relay-mark to speed a check that in practice never runs
-- is not a demonstrated need.
CREATE INDEX idx_outbox_events_school_unrelayed
  ON app.outbox_events (school_id, id)
  WHERE relayed_at IS NULL;

REVOKE ALL PRIVILEGES ON TABLE app.outbox_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.outbox_events TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'outbox_events');

RESET ROLE;
