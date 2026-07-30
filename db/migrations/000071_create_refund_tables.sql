-- ST-124: refund processing with maker-checker workflow and idempotent ERPNext credit note forwarding.
--
-- Two new tables extend the finance read model for refunds:
--
--   1. refund_requests — local refund state with a maker-checker lifecycle. A refund starts as
--      pending_approval (maker), is approved (checker), forwarded to ERPNext as a Sales Invoice
--      return/credit note, and ultimately confirmed by a webhook.
--
--   2. refund_idempotency_logs — the durable exactly-once guard that prevents duplicate credit
--      notes when a request is retried.
--
-- What this migration deliberately does NOT do:
--
--   * It does not add decimal `amount` or varchar `currency` columns. The cache convention set in
--     000015 stores monetary values as amount_minor bigint + currency_id uuid FK; see
--     apps/api/src/modules/finance/currency.ts for the conversion helpers.
--   * It does not compute or store the refundable balance. ERPNext owns every financial rule:
--     whether the invoice has been paid enough to refund, and whether a return exceeds the net
--     paid amount. The gateway forwards the request and returns ERPNext's refusal unchanged.
--   * It does not backfill any existing data — there are no refund requests before this feature.
--
-- Depends on 000004 (app.schools), 000005 (app.currencies), 000015 (app.payment_cache),
-- 000015 (app.finance_entity_type, app.erpnext_webhook_dedup).
-- EBR count: 3 (refund_requests, refund_idempotency_logs, refund entity type)

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- 1. Extend the entity type enum for crosswalk / idempotency
-- ---------------------------------------------------------------------------
ALTER TYPE app.finance_entity_type ADD VALUE IF NOT EXISTS 'refund';

-- ---------------------------------------------------------------------------
-- 2. app.refund_requests — maker-checker workflow table
-- ---------------------------------------------------------------------------

CREATE TABLE app.refund_requests (
  id                      uuid DEFAULT gen_random_uuid()
                            CONSTRAINT pk_refund_requests PRIMARY KEY,
  school_id               uuid NOT NULL,
  payment_entry_id        uuid,
  erpnext_invoice_id      text NOT NULL,
  erpnext_credit_note_id  text,
  student_id              uuid NOT NULL,
  amount_minor            bigint NOT NULL,
  currency_id             uuid NOT NULL,
  reason_code             text NOT NULL,
  reason_notes            text,
  status                  text NOT NULL DEFAULT 'pending_approval',
  maker_id                uuid NOT NULL,
  checker_id              uuid,
  idempotency_key         varchar(255) NOT NULL,
  approved_at             timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_refund_requests_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_refund_requests_payment_entry
    FOREIGN KEY (payment_entry_id) REFERENCES app.payment_cache (id)
    ON UPDATE RESTRICT ON DELETE SET NULL,

  CONSTRAINT fk_refund_requests_student
    FOREIGN KEY (student_id) REFERENCES app.students (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_refund_requests_currency
    FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_refund_requests_reason_code CHECK (
    reason_code IN ('overpayment', 'withdrawal', 'discount_adjustment', 'error_correction')
  ),

  CONSTRAINT ck_refund_requests_status CHECK (
    status IN ('pending_approval', 'approved', 'rejected', 'submitted_to_erpnext', 'completed', 'failed')
  ),

  CONSTRAINT ck_refund_requests_idempotency_key CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
  ),

  CONSTRAINT ck_refund_requests_amount_minor CHECK (amount_minor > 0),

  CONSTRAINT ck_refund_requests_erpnext_invoice_id CHECK (
    erpnext_invoice_id = btrim(erpnext_invoice_id) AND erpnext_invoice_id <> ''
  ),

  CONSTRAINT ck_refund_requests_erpnext_credit_note_id CHECK (
    erpnext_credit_note_id IS NULL
    OR (erpnext_credit_note_id = btrim(erpnext_credit_note_id) AND erpnext_credit_note_id <> '')
  ),

  -- An approved/confirmed refund must carry the approving user and timestamp.
  -- Rejected and submitted_to_erpnext also set checker_id.
  CONSTRAINT ck_refund_requests_checker_requires_fields CHECK (
    (checker_id IS NOT NULL) = (status IN ('approved', 'rejected', 'submitted_to_erpnext', 'completed', 'failed'))
  ),

  CONSTRAINT ck_refund_requests_approved_requires_fields CHECK (
    (status = 'approved' AND approved_at IS NOT NULL)
    OR (status <> 'approved')
  ),

  CONSTRAINT ck_refund_requests_submitted_requires_fields CHECK (
    (status = 'submitted_to_erpnext' AND approved_at IS NOT NULL)
    OR (status <> 'submitted_to_erpnext')
  ),

  CONSTRAINT ck_refund_requests_completed_requires_fields CHECK (
    (status = 'completed' AND erpnext_credit_note_id IS NOT NULL AND completed_at IS NOT NULL)
    OR (status <> 'completed')
  ),

  CONSTRAINT ck_refund_requests_timestamps CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- 3. Indexes for refund_requests
-- ---------------------------------------------------------------------------

-- Student refund history lookup.
CREATE INDEX idx_refund_requests_student
  ON app.refund_requests (school_id, student_id, status, created_at DESC);

-- Maker-checker queue: pending approvals for a tenant.
CREATE INDEX idx_refund_requests_pending
  ON app.refund_requests (school_id, status)
  WHERE status = 'pending_approval';

-- Credit note match for webhook processing.
CREATE INDEX idx_refund_requests_credit_note
  ON app.refund_requests (school_id, erpnext_credit_note_id)
  WHERE erpnext_credit_note_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. app.refund_idempotency_logs — durable exactly-once guard
-- ---------------------------------------------------------------------------

CREATE TABLE app.refund_idempotency_logs (
  id                      uuid DEFAULT gen_random_uuid()
                            CONSTRAINT pk_refund_idempotency_logs PRIMARY KEY,
  school_id               uuid NOT NULL,
  idempotency_key         varchar(255) NOT NULL,
  erpnext_credit_note_id  text,
  request_hash            varchar(64) NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_refund_idempotency_logs_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_refund_idempotency_logs_key CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
  ),

  CONSTRAINT ck_refund_idempotency_logs_credit_note_id CHECK (
    erpnext_credit_note_id IS NULL
    OR (
      erpnext_credit_note_id = btrim(erpnext_credit_note_id)
      AND erpnext_credit_note_id <> ''
    )
  ),

  CONSTRAINT ck_refund_idempotency_logs_request_hash CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  )
);

-- Tenant-scoped unique constraint on idempotency keys.
CREATE UNIQUE INDEX idx_refund_idempotency_unique
  ON app.refund_idempotency_logs (school_id, idempotency_key);

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.refund_requests FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.refund_requests TO studafy_app;

REVOKE ALL PRIVILEGES ON TABLE app.refund_idempotency_logs FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.refund_idempotency_logs TO studafy_app;

-- ---------------------------------------------------------------------------
-- 6. RLS policies
-- ---------------------------------------------------------------------------

SELECT app.apply_tenant_isolation('app', 'refund_requests');
SELECT app.apply_tenant_isolation('app', 'refund_idempotency_logs');

RESET ROLE;
