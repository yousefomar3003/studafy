-- Transactional email channel (deliverability R-08). Sends invitation, verification, dunning,
-- digest, and alert emails through SES and records delivery, bounce, and complaint state.
--
-- Three concerns, three tables:
--   1. app.email_deliveries — one row per (outbox event, recipient). This is the delivery ledger
--      and, crucially, the dedup arbiter for the email dispatcher: an outbox event fans out to N
--      recipients (an attendance alert carries parentUserIds), the dispatcher claims each recipient
--      with INSERT ... ON CONFLICT DO NOTHING on uq_email_deliveries_event_recipient, and only rows
--      that won the insert are sent. The unique index is the guarantee, exactly as it is for
--      app.attendance_alert_logs (000056) — a check-then-send would duplicate mail under BullMQ
--      retries and concurrent workers.
--   2. app.email_suppressions — an address SES permanently bounced or complained about. Checked
--      before every send; a suppressed address is never mailed again. Global by construction:
--      suppression is a property of the address, not of any one tenant.
--   3. app.email_events — the webhook ledger. Every verified SNS bounce/complaint/delivery
--      notification lands here once (deduplicated on (message_id, event_type)), both for audit and
--      as the source the suppression rows are derived from.
--
-- Why email_deliveries carries no foreign key to app.outbox_events: outbox_events is an append-only
-- log whose only key is its single-column identity (000022 deliberately adds no other index), and
-- both tables are tenant-isolated, so a referential FK would force the composite
-- (school_id, outbox_event_id) shape this schema's ST-050 coverage enforces — which requires a
-- unique (school_id, id) constraint on the hottest write path in the database, maintained on every
-- relayed_at/email_dispatched_at update, for a relationship the domain never navigates. The
-- dispatcher writes outbox_event_id from the same claimed row it reads, so the correlation cannot
-- diverge at write time, and the webhook correlates by SES message_id (email_deliveries.message_id),
-- not by outbox row. A plain correlation column with this rationale is the honest trade.
--
-- The dispatcher claims email-relevant outbox rows with a second cursor of its own:
--   SELECT id FROM app.outbox_events WHERE school_id = $1 AND event_name IN (...) AND
--     email_dispatched_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
-- then UPDATE ... SET email_dispatched_at = now() WHERE id = ANY(claimed ids), in the same
-- transaction as the claim, once every recipient row has reached a terminal status. Independent of
-- relayed_at: outbox-relay and the email dispatcher never block or double-consume each other.

SET LOCAL ROLE studafy_admin;

CREATE TYPE app.email_template AS ENUM ('invitation', 'verification', 'dunning', 'digest', 'alert');
CREATE TYPE app.email_delivery_status AS ENUM ('claimed', 'sent', 'bounced', 'complained', 'suppressed', 'failed');
CREATE TYPE app.email_suppression_reason AS ENUM ('bounce', 'complaint');
CREATE TYPE app.email_event_type AS ENUM ('bounce', 'complaint', 'delivery');

ALTER TABLE app.outbox_events
  ADD COLUMN email_dispatched_at timestamptz;

ALTER TABLE app.outbox_events
  ADD CONSTRAINT ck_outbox_events_email_dispatched_at
  CHECK (email_dispatched_at IS NULL OR email_dispatched_at >= created_at);

-- The email dispatcher's claim path. Sibling to idx_outbox_events_school_unrelayed: same ordering,
-- different predicate, so the two consumers each get an index whose partial predicate matches their
-- own claim query and nothing else.
CREATE INDEX idx_outbox_events_school_email_pending
  ON app.outbox_events (school_id, id)
  WHERE email_dispatched_at IS NULL;

CREATE TABLE app.email_deliveries (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_email_deliveries PRIMARY KEY,
  school_id uuid NOT NULL,
  outbox_event_id bigint NOT NULL,
  recipient text NOT NULL,
  template app.email_template NOT NULL,
  status app.email_delivery_status NOT NULL DEFAULT 'claimed',
  message_id text,
  attempts smallint NOT NULL DEFAULT 1,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_email_deliveries_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_email_deliveries_event_recipient UNIQUE (outbox_event_id, recipient),
  CONSTRAINT fk_email_deliveries_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_email_deliveries_recipient CHECK (
    recipient = lower(btrim(recipient)) AND recipient <> ''
      AND char_length(recipient) <= 320 AND position('@' in recipient) > 1
  ),
  CONSTRAINT ck_email_deliveries_message_id CHECK (
    message_id IS NULL OR (message_id = btrim(message_id) AND message_id <> '' AND char_length(message_id) <= 200)
  ),
  CONSTRAINT ck_email_deliveries_attempts CHECK (attempts >= 1 AND attempts <= 10),
  CONSTRAINT ck_email_deliveries_last_error CHECK (
    last_error IS NULL OR (last_error = btrim(last_error) AND last_error <> '' AND char_length(last_error) <= 1000)
  ),
  -- A send either landed with SES (message_id present) or has not yet, and a row is failed only
  -- after it exhausted its attempts. 'bounced'/'complained' are terminal webhook transitions of a
  -- row that did land. 'suppressed' is the dispatcher declining to send to an address on the
  -- global suppression list — terminal, like a send, but with nothing ever leaving the box.
  CONSTRAINT ck_email_deliveries_terminal_state CHECK (
    (status = 'claimed' AND message_id IS NULL)
    OR (status IN ('sent', 'bounced', 'complained') AND message_id IS NOT NULL)
    OR (status = 'suppressed' AND message_id IS NULL AND last_error IS NULL)
    OR (status = 'failed' AND message_id IS NULL AND last_error IS NOT NULL)
  ),
  CONSTRAINT ck_email_deliveries_timestamps CHECK (updated_at >= created_at)
);

-- The ST-050 school-leading B-tree every tenant-isolated table must expose; also the per-tenant
-- audit/backfill shape ("everything this tenant ever sent").
CREATE INDEX idx_email_deliveries_school_created
  ON app.email_deliveries (school_id, created_at);

-- Webhook correlation: SES SNS events carry mail.messageId, which equals the SendEmail response
-- MessageId the dispatcher recorded. Partial because only landed rows carry one.
CREATE INDEX idx_email_deliveries_message_id
  ON app.email_deliveries (message_id)
  WHERE message_id IS NOT NULL;

CREATE TABLE app.email_suppressions (
  address text CONSTRAINT pk_email_suppressions PRIMARY KEY,
  reason app.email_suppression_reason NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_email_suppressions_address CHECK (
    address = lower(btrim(address)) AND address <> ''
      AND char_length(address) <= 320 AND position('@' in address) > 1
  )
);

CREATE TABLE app.email_events (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_email_events PRIMARY KEY,
  message_id text NOT NULL,
  event_type app.email_event_type NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- SNS delivers at-least-once; the same event arriving twice must be recorded once. The full SES
  -- payload stays in payload (all recipients for a bounce live in it, so no recipient column here —
  -- a per-recipient column would be a repeating group).
  CONSTRAINT uq_email_events_message_type UNIQUE (message_id, event_type),
  CONSTRAINT ck_email_events_message_id CHECK (
    message_id = btrim(message_id) AND message_id <> '' AND char_length(message_id) <= 200
  ),
  CONSTRAINT ck_email_events_payload CHECK (jsonb_typeof(payload) = 'object')
);

REVOKE ALL PRIVILEGES ON TABLE
  app.email_deliveries, app.email_suppressions, app.email_events
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE
  app.email_deliveries, app.email_suppressions, app.email_events
TO studafy_app;

REVOKE ALL ON TYPE
  app.email_template, app.email_delivery_status,
  app.email_suppression_reason, app.email_event_type
FROM PUBLIC;
GRANT USAGE ON TYPE
  app.email_template, app.email_delivery_status,
  app.email_suppression_reason, app.email_event_type
TO studafy_app;

-- Tenant isolation for the delivery ledger. email_suppressions and email_events are deliberately
-- NOT isolated: they are global, pre-tenant surfaces (a webhook arrives before any tenant context
-- exists and suppression is an address-level fact), and are registered in the ST-050 approved-global
-- allowlist (db/policies/rls-coverage.ts) with that rationale.
SELECT app.apply_tenant_isolation('app', 'email_deliveries');

COMMENT ON TABLE app.email_deliveries IS
  'Per-recipient delivery ledger keyed by (outbox_event_id, recipient); the dedup arbiter for SES sends.';
COMMENT ON TABLE app.email_suppressions IS
  'Global address-level suppression list fed by SES bounce/complaint events and consulted before every send.';
COMMENT ON TABLE app.email_events IS
  'Deduplicated SES SNS event ledger (bounce/complaint/delivery) keyed by (message_id, event_type).';

RESET ROLE;
