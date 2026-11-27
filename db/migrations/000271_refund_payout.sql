-- How a refund's money goes back to the family, and how its approval settled it
-- (docs/plans/erpnext-fly.md, "Known issues found while testing").
--
-- Most schools in Jordan are paid in cash, so a refund that is not simply taken off what an invoice
-- still owes is usually handed back in cash at the school. The maker says how when asking for the
-- refund, so the checker approves the cash leaving the school along with the refund itself:
--
--   app.refund_requests.payout_mode     cash | bank_transfer | card_external, or credit (keep it on
--                                       the family's account for a later invoice). Defaults to cash.
--   app.refund_requests.settlement      what the approval did: pending until then; invoice (all of
--                                       it taken off what the invoice owed), paid_out (the rest
--                                       handed back by payout_mode) or family_credit (the rest kept
--                                       on the family's account).
--   app.refund_requests.paid_out_minor  how much was handed back, in minor units; 0 unless paid_out.
--
-- The approval posts one Credit Note Journal Entry that credits the invoice first and pays out (or
-- keeps) the rest in the same voucher, so nothing is left open in ERPNext. Columns only: RLS and
-- grants on app.refund_requests are unchanged.

ALTER TABLE app.refund_requests
  ADD COLUMN IF NOT EXISTS payout_mode text NOT NULL DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS settlement text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS paid_out_minor bigint NOT NULL DEFAULT 0;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_refund_requests_payout_mode'
      AND conrelid = 'app.refund_requests'::regclass
  ) THEN
    ALTER TABLE app.refund_requests
      ADD CONSTRAINT ck_refund_requests_payout_mode CHECK (
        payout_mode IN ('cash', 'bank_transfer', 'card_external', 'credit')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_refund_requests_settlement'
      AND conrelid = 'app.refund_requests'::regclass
  ) THEN
    ALTER TABLE app.refund_requests
      ADD CONSTRAINT ck_refund_requests_settlement CHECK (
        settlement IN ('pending', 'invoice', 'paid_out', 'family_credit')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_refund_requests_paid_out_minor'
      AND conrelid = 'app.refund_requests'::regclass
  ) THEN
    -- Something is handed back only when the refund was paid out, and never more than the refund.
    ALTER TABLE app.refund_requests
      ADD CONSTRAINT ck_refund_requests_paid_out_minor CHECK (
        paid_out_minor >= 0
        AND paid_out_minor <= amount_minor
        AND (settlement = 'paid_out') = (paid_out_minor > 0)
      );
  END IF;
END
$do$;

COMMENT ON COLUMN app.refund_requests.payout_mode IS
  'How the part of a refund not taken off the invoice goes back to the family: cash, bank_transfer, card_external, or credit (kept on their account).';
COMMENT ON COLUMN app.refund_requests.settlement IS
  'What the approval did: pending, invoice (taken off what the invoice owed), paid_out (the rest handed back by payout_mode), family_credit (the rest kept on the family''s account).';
COMMENT ON COLUMN app.refund_requests.paid_out_minor IS
  'How much of the refund was handed back to the family, in minor units; 0 unless settlement is paid_out.';
