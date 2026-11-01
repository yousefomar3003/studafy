-- Corrections finance can ask for, all through the refund maker-checker queue (000071): a FINANCE
-- user asks, a different user holding billing:refund approves, and only the approval reaches
-- ERPNext. One queue, one audit trail, one place a school admin looks.
--
--   * credit_note           -- what every existing row is: a Sales Invoice return against an
--                              invoice (a refund, a fee correction, or a write-off of a balance
--                              that will not be collected).
--   * invoice_cancellation  -- cancel an invoice nothing has been paid against (ERPNext docstatus
--                              2). A part-paid invoice is corrected with a credit note instead.
--   * payment_reversal      -- cancel a payment recorded by mistake; the invoice it settled is
--                              owed again.
--
-- A cancellation or reversal has no credit note: it completes when ERPNext confirms the cancel,
-- synchronously, so the completed check no longer demands erpnext_credit_note_id for those two.
-- 'write_off' joins the reason codes. One open request per invoice cancellation and per payment
-- reversal (pending or done), so two people cannot ask twice.
--
-- app.payment_cache gains 'reversed': a payment that was confirmed and then cancelled. It keeps its
-- confirmed_at (the money did arrive once), so the confirmed-state rule now covers both.

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- 1. app.refund_requests: kind, write-off reason
-- ---------------------------------------------------------------------------

ALTER TABLE app.refund_requests
  ADD COLUMN kind text NOT NULL DEFAULT 'credit_note',
  ADD CONSTRAINT ck_refund_requests_kind CHECK (
    kind IN ('credit_note', 'invoice_cancellation', 'payment_reversal')
  ),
  -- A reversal names the payment it cancels; nothing else may.
  ADD CONSTRAINT ck_refund_requests_reversal_payment CHECK (
    (kind = 'payment_reversal') = (payment_entry_id IS NOT NULL)
  );

ALTER TABLE app.refund_requests
  DROP CONSTRAINT ck_refund_requests_reason_code,
  ADD CONSTRAINT ck_refund_requests_reason_code CHECK (
    reason_code IN (
      'overpayment', 'withdrawal', 'discount_adjustment', 'error_correction', 'write_off'
    )
  );

ALTER TABLE app.refund_requests
  DROP CONSTRAINT ck_refund_requests_completed_requires_fields,
  ADD CONSTRAINT ck_refund_requests_completed_requires_fields CHECK (
    status <> 'completed'
    OR (
      completed_at IS NOT NULL
      AND (kind <> 'credit_note' OR erpnext_credit_note_id IS NOT NULL)
    )
  );

CREATE UNIQUE INDEX uq_refund_requests_open_cancellation
  ON app.refund_requests (school_id, erpnext_invoice_id)
  WHERE kind = 'invoice_cancellation'
    AND status IN ('pending_approval', 'approved', 'completed');

CREATE UNIQUE INDEX uq_refund_requests_open_reversal
  ON app.refund_requests (school_id, payment_entry_id)
  WHERE kind = 'payment_reversal'
    AND status IN ('pending_approval', 'approved', 'completed');

-- ---------------------------------------------------------------------------
-- 2. app.payment_cache: 'reversed'
-- ---------------------------------------------------------------------------

ALTER TABLE app.payment_cache
  DROP CONSTRAINT ck_payment_cache_status,
  ADD CONSTRAINT ck_payment_cache_status CHECK (
    status IN ('pending', 'confirmed', 'failed', 'reversed')
  ),
  DROP CONSTRAINT ck_payment_cache_confirmed_state,
  ADD CONSTRAINT ck_payment_cache_confirmed_state CHECK (
    (status IN ('confirmed', 'reversed')) = (confirmed_at IS NOT NULL)
  );

RESET ROLE;
