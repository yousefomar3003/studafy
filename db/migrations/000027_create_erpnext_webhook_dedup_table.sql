-- Lightweight dedup table for ERPNext webhook ingestion. ERPNext may redeliver a webhook (at-least-
-- once), so we track processed event IDs to ensure idempotent handling. The row is inserted in the
-- same transaction as the outbox_events insert, so either both succeed or neither does.
--
-- Depends on 000004 (app.schools) for the tenant foreign key and 000006 (app.apply_tenant_isolation)
-- for RLS.

SET ROLE studafy_admin;

CREATE TABLE app.erpnext_webhook_dedup (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_erpnext_webhook_dedup PRIMARY KEY,
  school_id uuid NOT NULL,
  event_id text NOT NULL,
  doc_type text NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_erpnext_webhook_dedup_school_event UNIQUE (school_id, event_id),
  CONSTRAINT fk_erpnext_webhook_dedup_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_erpnext_webhook_dedup_event_id CHECK (
    event_id = btrim(event_id) AND event_id <> ''
  )
);

-- TTL index: rows older than 30 days can be vacuumed. No application query needs historical dedup.
CREATE INDEX idx_erpnext_webhook_dedup_created_at ON app.erpnext_webhook_dedup (created_at);

REVOKE ALL PRIVILEGES ON TABLE app.erpnext_webhook_dedup FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE app.erpnext_webhook_dedup TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'erpnext_webhook_dedup');

RESET ROLE;
