-- The school chooses its licence length and payment plan; AI stops 30 days after an unpaid instalment.
--
-- ## 1. The school's choice (ADR-021, amended)
--
-- Until now the super admin chose how long a licence runs and how it is paid. Now the school proposes
-- both when it asks for AI seats, and the super admin prices the quote from that request: keeping the
-- school's choice, or changing it with a reason the school reads on the quote. The school still
-- accepts (or declines) the priced quote, so nothing is billed that the school did not see.
--
--   * app.license_change_requests.months           -- the length the school wants (1-36 from the
--     API; up to 120 here, the pricing package's limit). NULL: left to Studafy / the licence's term.
--   * app.license_change_requests.starts_on        -- when a new licence should start (optional).
--   * app.license_change_requests.payment_plan     -- monthly, yearly or custom (NULL: not chosen).
--   * app.license_change_requests.payment_proposal -- for custom: [{"dueDate": "YYYY-MM-DD",
--     "shareBps": n}], shares of the not yet priced total adding up to 10000 (validated by the API
--     with @studafy/license-pricing proposalErrors).
--   * app.license_quotes.change_request_id         -- the request a quote answers (same school).
--   * app.license_quotes.terms_change_reason       -- why the quote's length, start or plan differs
--     from the request's; required by the API whenever it does.
--   * payment_plan on quotes and invoices gains `yearly`: one instalment per licence year, each year
--     paying for its own months.
--
-- Accepting a quote that answers an open request resolves the request in the same transaction.
--
-- ## 2. AI stops 30 days after an unpaid instalment
--
-- The workers' hourly licence lifecycle job suspends an active licence once any unpaid instalment of
-- one of its open invoices is 30 or more days past its due date (UTC dates), and sets
-- nonpayment_suspended_at so the stop can be told apart from a super admin's own suspension. Recording
-- the payment (or voiding the invoice) resumes it at once; the job resumes any it finds settled too.
-- A licence the super admin suspended by hand is never resumed automatically.
--
--   * app.school_licenses.nonpayment_suspended_at  -- when the licence was stopped for non-payment;
--     cleared by trigger whenever the status leaves `suspended` (resumed, cancelled, expired).
--   * app.license_reminders.kind gains ai_stop_warning (7 days before the cutoff) and ai_stopped.
--   * app.notification_type gains LICENSE_AI_STOP_WARNING and LICENSE_AI_STOPPED (in-app and push
--     for the school's admins and principals and the super admins; never emailed). Nothing in this
--     migration uses them, so they can be added inside its transaction.
--
-- Depends on 000163 (licences, change requests), 000165 (billing), 000168 (request tiers), 000221
-- (instalments), 000223 (quote decline).

-- The FK validation scan below reads app.license_change_requests, which has forced RLS: a
-- non-matching tenant context lets it run (as in 000168).
SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Payment plans gain `yearly`
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.license_quotes DROP CONSTRAINT ck_license_quotes_payment_plan;
ALTER TABLE app.license_quotes
  ADD CONSTRAINT ck_license_quotes_payment_plan CHECK (
    payment_plan IN ('in_full', 'monthly', 'yearly', 'custom')
  );

ALTER TABLE app.license_invoices DROP CONSTRAINT ck_license_invoices_payment_plan;
ALTER TABLE app.license_invoices
  ADD CONSTRAINT ck_license_invoices_payment_plan CHECK (
    payment_plan IN ('in_full', 'monthly', 'yearly', 'custom')
  );

COMMENT ON COLUMN app.license_quotes.payment_plan IS
  'How the invoice this quote issues is paid: in_full, monthly over the licence months, yearly (one instalment per licence year), or custom (000221, 000231).';

-- ---------------------------------------------------------------------------------------------------
-- 2. The school's choice on its request
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.license_change_requests
  ADD COLUMN months integer,
  ADD COLUMN starts_on date,
  ADD COLUMN payment_plan text,
  ADD COLUMN payment_proposal jsonb;

ALTER TABLE app.license_change_requests
  ADD CONSTRAINT ck_license_change_requests_months CHECK (
    months IS NULL OR months BETWEEN 1 AND 120
  ),
  ADD CONSTRAINT ck_license_change_requests_payment_plan CHECK (
    payment_plan IS NULL OR payment_plan IN ('in_full', 'monthly', 'yearly', 'custom')
  ),
  ADD CONSTRAINT ck_license_change_requests_payment_proposal CHECK (
    (payment_plan IS NOT DISTINCT FROM 'custom') = (payment_proposal IS NOT NULL)
    AND (payment_proposal IS NULL OR jsonb_typeof(payment_proposal) = 'array')
  );

COMMENT ON COLUMN app.license_change_requests.months IS
  'The licence length in months the school asks for, or NULL to leave it to Studafy (000231).';
COMMENT ON COLUMN app.license_change_requests.starts_on IS
  'When the school wants a new licence to start, or NULL for as soon as possible (000231).';
COMMENT ON COLUMN app.license_change_requests.payment_plan IS
  'How the school wants to pay: monthly, yearly or custom; NULL when not chosen (000231).';
COMMENT ON COLUMN app.license_change_requests.payment_proposal IS
  'For a custom plan, the school''s payments: [{"dueDate": "YYYY-MM-DD", "shareBps": n}], shares adding up to 10000 (000231).';

-- ---------------------------------------------------------------------------------------------------
-- 3. The quote answering a request, and why it departs from it
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.license_quotes
  ADD COLUMN change_request_id uuid,
  ADD COLUMN terms_change_reason text;

ALTER TABLE app.license_quotes
  ADD CONSTRAINT fk_license_quotes_change_request FOREIGN KEY (change_request_id, school_id)
    REFERENCES app.license_change_requests (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT ck_license_quotes_terms_change_reason CHECK (
    terms_change_reason IS NULL
    OR (
      change_request_id IS NOT NULL
      AND terms_change_reason = btrim(terms_change_reason)
      AND terms_change_reason <> ''
      AND char_length(terms_change_reason) <= 1000
    )
  );

CREATE INDEX idx_license_quotes_school_change_request
  ON app.license_quotes (school_id, change_request_id)
  WHERE change_request_id IS NOT NULL;

COMMENT ON COLUMN app.license_quotes.change_request_id IS
  'The school''s request this quote answers; accepting the quote resolves it (000231).';
COMMENT ON COLUMN app.license_quotes.terms_change_reason IS
  'Why the quote''s length, start date or payment plan differs from what the school asked for (000231).';

-- ---------------------------------------------------------------------------------------------------
-- 4. Stopped for non-payment
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.school_licenses
  ADD COLUMN nonpayment_suspended_at timestamptz;

ALTER TABLE app.school_licenses
  ADD CONSTRAINT ck_school_licenses_nonpayment_suspended CHECK (
    nonpayment_suspended_at IS NULL OR status = 'suspended'
  );

COMMENT ON COLUMN app.school_licenses.nonpayment_suspended_at IS
  'When the workers suspended this licence because an instalment was unpaid 30 days after its due date; NULL otherwise (000231).';

-- Leaving `suspended` (resumed by a payment or by the super admin, cancelled, expired) ends the stop.
CREATE FUNCTION app.school_licenses_clear_nonpayment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.status <> 'suspended' THEN
    NEW.nonpayment_suspended_at := NULL;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_school_licenses_clear_nonpayment
  BEFORE UPDATE OF status ON app.school_licenses
  FOR EACH ROW EXECUTE FUNCTION app.school_licenses_clear_nonpayment();

REVOKE ALL ON FUNCTION app.school_licenses_clear_nonpayment() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------
-- 5. Reminders and notification types
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.license_reminders DROP CONSTRAINT ck_license_reminders_kind;
ALTER TABLE app.license_reminders
  ADD CONSTRAINT ck_license_reminders_kind CHECK (
    kind IN ('license_expiring_30', 'license_expiring_7', 'invoice_due', 'invoice_overdue',
             'receipt_uploaded', 'ai_stop_warning', 'ai_stopped')
  );

-- Mirrors NOTIFICATION_TYPES in packages/constants/src/notifications.ts. Optional, like the other
-- licence reminders (000166): left out of ck_notification_preferences_mandatory_enabled and
-- ck_notification_preferences_digest_eligible (000083).
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'LICENSE_AI_STOP_WARNING';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'LICENSE_AI_STOPPED';

RESET ROLE;
