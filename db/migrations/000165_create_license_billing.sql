-- License pricing, quotes, invoices and bank-transfer payments: session 3 of
-- docs/billing/feature-licensing.md.
--
-- A school pays for its feature license by bank transfer: the super admin prices it with the
-- calculator (packages/license-pricing) and sends a quote; the school accepts it (or the super admin
-- marks it accepted), which issues an invoice carrying the platform's bank details and a unique
-- payment reference; the school transfers and may upload a receipt; the super admin records each
-- payment, partial ones included; the license activates once the invoice is paid in full, or earlier
-- when the super admin decides.
--
--   * app.license_price_settings   -- global, admin-only: per currency, whether volume discounts go by
--                                     each audience's seats or the license's total.
--   * app.license_price_brackets   -- global, admin-only: the volume and duration discount brackets
--                                     of a currency's settings.
--   * app.license_invoice_counters -- global, admin-only: the gapless invoice number sequence, per
--                                     year, handed out by app.next_license_invoice_number().
--   * app.license_quotes           -- a priced offer to one school: the license terms it prices, the
--                                     calculator's breakdown, the total and how long it is valid.
--   * app.license_invoices         -- what the school owes for an accepted quote: number, dates,
--                                     total, paid, balance, status and the payment reference.
--   * app.license_invoice_lines    -- the invoice's lines: seats per audience, overlap credits (one
--                                     per app.license_seat_overlaps row), the manual adjustment.
--   * app.license_payments         -- a bank transfer the super admin recorded against an invoice.
--                                     Voided with a reason, never deleted.
--   * app.license_payment_receipts -- a transfer receipt the school uploaded, pending until the super
--                                     admin matches it to a payment.
--   * app.license_reminders        -- which reminders the workers have sent, so each goes out once.
--
-- The platform's bank details are app.platform_settings rows (license.bank.*), written by the
-- super admin through the license console; two more settings say how long a quote is valid and when
-- an invoice falls due.
--
-- Money is bigint minor units of the row's currency, as everywhere else. An invoice's paid amount is
-- kept by the API under a row lock on the invoice; the CHECKs below make an inconsistent row
-- impossible to store whoever writes it (paid never above the total, the status always the one the
-- amounts imply).
--
-- created_by, sent_by, accepted_by, issued_by, recorded_by, voided_by and matched_by carry no foreign
-- key: the super admin is a user of their own home school (as in 000163). uploaded_by, always a
-- member of this school, does.
--
-- breakdown is the one JSONB column: the calculator's full result, kept so the school sees exactly
-- the offer it was sent (list and discounted price per seat, savings, the next volume bracket). The
-- invoice's lines, which are what is owed, are relational rows. Allowlisted in
-- db/policies/rls-coverage.ts.
--
-- Depends on 000004 (currencies, platform_settings), 000007 (users), 000163 (licenses, overlaps).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Price settings (global)
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.license_price_settings (
  currency_id uuid CONSTRAINT pk_license_price_settings PRIMARY KEY,
  -- per_audience: each audience's own seat count picks its bracket. overall: the license's total.
  volume_basis text NOT NULL DEFAULT 'per_audience',
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_license_price_settings_currency FOREIGN KEY (currency_id)
    REFERENCES app.currencies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_price_settings_volume_basis CHECK (volume_basis IN ('per_audience', 'overall')),
  CONSTRAINT ck_license_price_settings_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.license_price_brackets (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_license_price_brackets PRIMARY KEY,
  currency_id uuid NOT NULL,
  -- volume: from `threshold` seats up. duration: from `threshold` months up.
  kind text NOT NULL,
  -- A volume bracket for one audience, or NULL for every audience without brackets of its own.
  audience text,
  threshold integer NOT NULL,
  discount_bps integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_license_price_brackets_settings FOREIGN KEY (currency_id)
    REFERENCES app.license_price_settings (currency_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_license_price_brackets_kind CHECK (kind IN ('volume', 'duration')),
  CONSTRAINT ck_license_price_brackets_audience CHECK (
    audience IS NULL OR (kind = 'volume' AND audience IN ('student', 'teacher', 'parent'))
  ),
  CONSTRAINT ck_license_price_brackets_threshold CHECK (
    threshold >= 1 AND (kind = 'volume' OR threshold <= 120)
  ),
  CONSTRAINT ck_license_price_brackets_discount CHECK (discount_bps BETWEEN 0 AND 10000)
);

CREATE UNIQUE INDEX uq_license_price_brackets_threshold
  ON app.license_price_brackets (currency_id, kind, COALESCE(audience, '*'), threshold);

-- ---------------------------------------------------------------------------------------------------
-- 2. Invoice numbers (global)
-- ---------------------------------------------------------------------------------------------------

-- One row per year. The UPDATE in app.next_license_invoice_number() locks the year's row until the
-- issuing transaction ends, so numbers are handed out one at a time; a rolled-back invoice rolls its
-- number back with it, so the sequence has no gaps.
CREATE TABLE app.license_invoice_counters (
  year integer CONSTRAINT pk_license_invoice_counters PRIMARY KEY,
  last_number integer NOT NULL,
  CONSTRAINT ck_license_invoice_counters_year CHECK (year BETWEEN 2000 AND 9999),
  CONSTRAINT ck_license_invoice_counters_last_number CHECK (last_number >= 1)
);

-- LIC-<year>-<six digits>, the year being the issue date's (UTC).
CREATE FUNCTION app.next_license_invoice_number(issue_date date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  issue_year integer := extract(year FROM issue_date)::integer;
  next_number integer;
BEGIN
  INSERT INTO app.license_invoice_counters AS c (year, last_number)
  VALUES (issue_year, 1)
  ON CONFLICT (year) DO UPDATE SET last_number = c.last_number + 1
  RETURNING c.last_number INTO next_number;
  RETURN 'LIC-' || issue_year::text || '-' || lpad(next_number::text, 6, '0');
END
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 3. app.license_quotes
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.license_quotes (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_license_quotes PRIMARY KEY,
  school_id uuid NOT NULL,
  -- new: a license term (a new license, or the terms of one not yet paid). seat_increase: more seats
  -- on a license in force, charged for the rest of its term. extension: a later end date.
  kind text NOT NULL,
  -- The license priced: required for a change; for `new`, the draft or awaiting-payment license
  -- whose terms it sets, or NULL to create one on acceptance.
  license_id uuid,
  -- draft: being prepared. sent: the school can see and accept it. accepted: invoiced. expired: past
  -- valid_until unaccepted. withdrawn: taken back by the super admin.
  status text NOT NULL DEFAULT 'draft',
  currency_id uuid NOT NULL,
  -- The period charged: the term for `new`, the rest of the term for `seat_increase`, the added
  -- months for `extension`.
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- The term in whole months (picks the duration discount); prorate_days when seats are charged by
  -- the day (a seat increase).
  months integer NOT NULL,
  prorate_days integer,
  -- The license's tiers and seat totals once the quote is accepted.
  student_plan_id uuid,
  student_seats integer NOT NULL DEFAULT 0,
  teacher_plan_id uuid,
  teacher_seats integer NOT NULL DEFAULT 0,
  include_family_plus boolean NOT NULL DEFAULT false,
  parent_plan_id uuid,
  parent_seats integer NOT NULL DEFAULT 0,
  adjustment_minor bigint NOT NULL DEFAULT 0,
  adjustment_reason text,
  list_total_minor bigint NOT NULL,
  discount_total_minor bigint NOT NULL,
  credit_total_minor bigint NOT NULL,
  total_minor bigint NOT NULL,
  breakdown jsonb NOT NULL,
  -- When the breakdown was computed. Accepting refuses a quote whose license changed after this.
  priced_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_until timestamptz NOT NULL,
  notes text,
  created_by uuid NOT NULL,
  sent_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid,
  -- True when the super admin marked it accepted on the school's behalf.
  accepted_by_platform boolean,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_license_quotes_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_license_quotes_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_quotes_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_quotes_currency FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_quotes_student_plan FOREIGN KEY (student_plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_quotes_teacher_plan FOREIGN KEY (teacher_plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_quotes_parent_plan FOREIGN KEY (parent_plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_quotes_kind CHECK (kind IN ('new', 'seat_increase', 'extension')),
  CONSTRAINT ck_license_quotes_license CHECK (kind = 'new' OR license_id IS NOT NULL),
  CONSTRAINT ck_license_quotes_status CHECK (
    status IN ('draft', 'sent', 'accepted', 'expired', 'withdrawn')
  ),
  CONSTRAINT ck_license_quotes_period CHECK (ends_at > starts_at),
  CONSTRAINT ck_license_quotes_months CHECK (months BETWEEN 1 AND 120),
  CONSTRAINT ck_license_quotes_prorate CHECK (
    prorate_days IS NULL OR (kind = 'seat_increase' AND prorate_days BETWEEN 1 AND 3660)
  ),
  CONSTRAINT ck_license_quotes_seats CHECK (
    student_seats >= 0 AND teacher_seats >= 0 AND parent_seats >= 0
  ),
  CONSTRAINT ck_license_quotes_family_plus CHECK (
    include_family_plus OR (parent_plan_id IS NULL AND parent_seats = 0)
  ),
  CONSTRAINT ck_license_quotes_adjustment CHECK (
    (adjustment_minor = 0) = (adjustment_reason IS NULL)
    AND (adjustment_reason IS NULL OR (adjustment_reason = btrim(adjustment_reason) AND adjustment_reason <> ''))
  ),
  CONSTRAINT ck_license_quotes_amounts CHECK (
    list_total_minor >= 0 AND discount_total_minor >= 0 AND credit_total_minor >= 0
    AND total_minor >= 0
  ),
  CONSTRAINT ck_license_quotes_breakdown CHECK (jsonb_typeof(breakdown) = 'object'),
  CONSTRAINT ck_license_quotes_sent CHECK ((status = 'draft') = (sent_at IS NULL) OR status = 'withdrawn'),
  CONSTRAINT ck_license_quotes_accepted CHECK (
    (status = 'accepted') = (accepted_at IS NOT NULL)
    AND (accepted_at IS NULL) = (accepted_by IS NULL)
    AND (accepted_at IS NULL) = (accepted_by_platform IS NULL)
  ),
  CONSTRAINT ck_license_quotes_closed CHECK (
    (status IN ('expired', 'withdrawn')) = (closed_at IS NOT NULL)
  ),
  CONSTRAINT ck_license_quotes_notes CHECK (notes IS NULL OR (notes = btrim(notes) AND notes <> '')),
  CONSTRAINT ck_license_quotes_timestamps CHECK (updated_at >= created_at)
);

-- A school's quotes by status, newest first; also the expiry job's scan.
CREATE INDEX idx_license_quotes_school_status
  ON app.license_quotes (school_id, status, created_at DESC);
CREATE INDEX idx_license_quotes_school_license ON app.license_quotes (school_id, license_id);

-- ---------------------------------------------------------------------------------------------------
-- 4. app.license_invoices and their lines
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.license_invoices (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_license_invoices PRIMARY KEY,
  school_id uuid NOT NULL,
  license_id uuid NOT NULL,
  quote_id uuid,
  -- LIC-2026-000042: unique and sequential across the platform (app.next_license_invoice_number).
  number text NOT NULL,
  -- Printed on the invoice; the school puts it on the transfer so the payment can be matched.
  payment_reference text NOT NULL,
  currency_id uuid NOT NULL,
  issue_date date NOT NULL,
  due_date date NOT NULL,
  -- Seat lines after discounts, credits taken off (positive), the manual adjustment (signed).
  subtotal_minor bigint NOT NULL,
  credit_total_minor bigint NOT NULL DEFAULT 0,
  adjustment_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL,
  -- The sum of the invoice's payments that are not voided.
  paid_minor bigint NOT NULL DEFAULT 0,
  balance_minor bigint GENERATED ALWAYS AS (total_minor - paid_minor) STORED,
  status text NOT NULL,
  -- Set by the workers when the due date passes with a balance; the status says how much is paid.
  overdue_at timestamptz,
  issued_by uuid NOT NULL,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_license_invoices_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_license_invoices_number UNIQUE (number),
  CONSTRAINT uq_license_invoices_payment_reference UNIQUE (payment_reference),
  CONSTRAINT fk_license_invoices_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_invoices_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_invoices_quote FOREIGN KEY (quote_id, school_id)
    REFERENCES app.license_quotes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_invoices_currency FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_invoices_number CHECK (number ~ '^LIC-[0-9]{4}-[0-9]{6,}$'),
  CONSTRAINT ck_license_invoices_payment_reference CHECK (payment_reference ~ '^STF-[0-9A-Z]{4}-[0-9A-Z]{4}$'),
  CONSTRAINT ck_license_invoices_dates CHECK (due_date >= issue_date),
  CONSTRAINT ck_license_invoices_amounts CHECK (
    subtotal_minor >= 0 AND credit_total_minor >= 0 AND total_minor >= 0
    AND total_minor = subtotal_minor - credit_total_minor + adjustment_minor
    AND paid_minor >= 0 AND paid_minor <= total_minor
  ),
  CONSTRAINT ck_license_invoices_status CHECK (
    CASE status
      WHEN 'issued' THEN paid_minor = 0 AND total_minor > 0 AND voided_at IS NULL
      WHEN 'partially_paid' THEN paid_minor > 0 AND paid_minor < total_minor AND voided_at IS NULL
      WHEN 'paid' THEN paid_minor = total_minor AND voided_at IS NULL
      WHEN 'void' THEN paid_minor = 0 AND voided_at IS NOT NULL
      ELSE false
    END
  ),
  CONSTRAINT ck_license_invoices_void CHECK (
    (voided_at IS NULL) = (voided_by IS NULL)
    AND (voided_at IS NULL) = (void_reason IS NULL)
    AND (void_reason IS NULL OR (void_reason = btrim(void_reason) AND void_reason <> ''))
  ),
  CONSTRAINT ck_license_invoices_timestamps CHECK (updated_at >= created_at)
);

-- An accepted quote is invoiced once.
CREATE UNIQUE INDEX uq_license_invoices_quote
  ON app.license_invoices (school_id, quote_id)
  WHERE quote_id IS NOT NULL;
-- A school's invoices by status and due date: the school's list, the overdue and reminder scans.
CREATE INDEX idx_license_invoices_school_status_due
  ON app.license_invoices (school_id, status, due_date);
CREATE INDEX idx_license_invoices_school_license ON app.license_invoices (school_id, license_id);

CREATE TABLE app.license_invoice_lines (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_license_invoice_lines PRIMARY KEY,
  school_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  position integer NOT NULL,
  -- seats: one audience's seats. overlap_credit: one app.license_seat_overlaps row's credit.
  -- adjustment: the super admin's manual change, with its reason as the description.
  kind text NOT NULL,
  description text NOT NULL,
  audience text,
  plan_id uuid,
  seats integer,
  months integer,
  prorate_days integer,
  list_price_per_seat_month_minor bigint,
  list_amount_minor bigint,
  volume_discount_bps integer,
  volume_discount_minor bigint,
  duration_discount_bps integer,
  duration_discount_minor bigint,
  -- What the line adds to the invoice: positive for seats, negative for a credit, either for an
  -- adjustment.
  amount_minor bigint NOT NULL,
  overlap_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_license_invoice_lines_position UNIQUE (school_id, invoice_id, position),
  CONSTRAINT fk_license_invoice_lines_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_invoice_lines_invoice FOREIGN KEY (invoice_id, school_id)
    REFERENCES app.license_invoices (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_invoice_lines_plan FOREIGN KEY (plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_invoice_lines_overlap FOREIGN KEY (overlap_id, school_id)
    REFERENCES app.license_seat_overlaps (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_invoice_lines_kind CHECK (kind IN ('seats', 'overlap_credit', 'adjustment')),
  CONSTRAINT ck_license_invoice_lines_position CHECK (position >= 1),
  CONSTRAINT ck_license_invoice_lines_description CHECK (
    description = btrim(description) AND description <> ''
  ),
  CONSTRAINT ck_license_invoice_lines_seats CHECK (
    (kind = 'seats') = (
      audience IS NOT NULL AND plan_id IS NOT NULL AND seats IS NOT NULL AND months IS NOT NULL
      AND list_price_per_seat_month_minor IS NOT NULL AND list_amount_minor IS NOT NULL
      AND volume_discount_bps IS NOT NULL AND volume_discount_minor IS NOT NULL
      AND duration_discount_bps IS NOT NULL AND duration_discount_minor IS NOT NULL
    )
    AND (audience IS NULL OR audience IN ('student', 'teacher', 'parent'))
    AND (kind <> 'seats' OR (seats > 0 AND amount_minor >= 0))
  ),
  CONSTRAINT ck_license_invoice_lines_credit CHECK (
    (kind = 'overlap_credit') = (overlap_id IS NOT NULL)
    AND (kind <> 'overlap_credit' OR amount_minor <= 0)
  )
);

CREATE INDEX idx_license_invoice_lines_school_overlap
  ON app.license_invoice_lines (school_id, overlap_id)
  WHERE overlap_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- 5. app.license_payments and app.license_payment_receipts
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.license_payments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_license_payments PRIMARY KEY,
  school_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_minor bigint NOT NULL,
  currency_id uuid NOT NULL,
  received_at timestamptz NOT NULL,
  -- The bank's reference for the transfer, as on the statement.
  bank_reference text NOT NULL,
  method text NOT NULL DEFAULT 'bank_transfer',
  -- A receipt file the super admin attached (permanent/<school>/... in object storage).
  receipt_storage_key text,
  recorded_by uuid NOT NULL,
  note text,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_license_payments_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_license_payments_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_payments_invoice FOREIGN KEY (invoice_id, school_id)
    REFERENCES app.license_invoices (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_payments_currency FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_payments_amount CHECK (amount_minor > 0),
  CONSTRAINT ck_license_payments_method CHECK (method = 'bank_transfer'),
  CONSTRAINT ck_license_payments_bank_reference CHECK (
    bank_reference = btrim(bank_reference) AND bank_reference <> ''
  ),
  CONSTRAINT ck_license_payments_note CHECK (note IS NULL OR (note = btrim(note) AND note <> '')),
  CONSTRAINT ck_license_payments_void CHECK (
    (voided_at IS NULL) = (voided_by IS NULL)
    AND (voided_at IS NULL) = (void_reason IS NULL)
    AND (void_reason IS NULL OR (void_reason = btrim(void_reason) AND void_reason <> ''))
  ),
  CONSTRAINT ck_license_payments_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_license_payments_school_invoice
  ON app.license_payments (school_id, invoice_id, received_at);
-- The finance overview's "received this month".
CREATE INDEX idx_license_payments_school_received
  ON app.license_payments (school_id, received_at)
  WHERE voided_at IS NULL;

-- A payment can be voided once, and only that.
CREATE FUNCTION app.license_payments_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.voided_at IS NOT NULL
     OR NEW.voided_at IS NULL
     OR (NEW.invoice_id, NEW.amount_minor, NEW.currency_id, NEW.received_at, NEW.bank_reference,
         NEW.method, NEW.receipt_storage_key, NEW.recorded_by, NEW.note)
        IS DISTINCT FROM
        (OLD.invoice_id, OLD.amount_minor, OLD.currency_id, OLD.received_at, OLD.bank_reference,
         OLD.method, OLD.receipt_storage_key, OLD.recorded_by, OLD.note)
  THEN
    RAISE EXCEPTION 'a payment can only be voided, once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_payments_void_only',
            TABLE = 'license_payments', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_license_payments_before_update
  BEFORE UPDATE ON app.license_payments
  FOR EACH ROW EXECUTE FUNCTION app.license_payments_before_update();

CREATE TABLE app.license_payment_receipts (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_license_payment_receipts PRIMARY KEY,
  school_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  storage_key text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  note text,
  uploaded_by uuid NOT NULL,
  -- pending: waiting for the super admin. matched: tied to the payment it evidences.
  status text NOT NULL DEFAULT 'pending',
  payment_id uuid,
  matched_at timestamptz,
  matched_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_license_payment_receipts_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_license_payment_receipts_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_payment_receipts_invoice FOREIGN KEY (invoice_id, school_id)
    REFERENCES app.license_invoices (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_payment_receipts_payment FOREIGN KEY (payment_id, school_id)
    REFERENCES app.license_payments (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_payment_receipts_uploaded_by FOREIGN KEY (uploaded_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_payment_receipts_status CHECK (status IN ('pending', 'matched')),
  CONSTRAINT ck_license_payment_receipts_match CHECK (
    (status = 'matched') = (payment_id IS NOT NULL)
    AND (payment_id IS NULL) = (matched_at IS NULL)
    AND (payment_id IS NULL) = (matched_by IS NULL)
  ),
  CONSTRAINT ck_license_payment_receipts_size CHECK (size_bytes > 0),
  CONSTRAINT ck_license_payment_receipts_note CHECK (note IS NULL OR (note = btrim(note) AND note <> '')),
  CONSTRAINT ck_license_payment_receipts_timestamps CHECK (updated_at >= created_at)
);

-- The pending list and a school's receipts per invoice.
CREATE INDEX idx_license_payment_receipts_school_status
  ON app.license_payment_receipts (school_id, status, created_at);
CREATE INDEX idx_license_payment_receipts_school_invoice
  ON app.license_payment_receipts (school_id, invoice_id);
CREATE INDEX idx_license_payment_receipts_school_payment
  ON app.license_payment_receipts (school_id, payment_id);
CREATE INDEX idx_license_payment_receipts_school_uploaded_by
  ON app.license_payment_receipts (school_id, uploaded_by);

-- ---------------------------------------------------------------------------------------------------
-- 6. app.license_reminders
-- ---------------------------------------------------------------------------------------------------

-- The workers' record of reminders sent: one row per (kind, license / invoice / receipt), written in
-- the transaction that writes the notifications, so a re-run sends nothing twice.
CREATE TABLE app.license_reminders (
  school_id uuid NOT NULL,
  kind text NOT NULL,
  subject_id uuid NOT NULL,
  recipients integer NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_license_reminders PRIMARY KEY (school_id, kind, subject_id),
  CONSTRAINT fk_license_reminders_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_reminders_kind CHECK (
    kind IN ('license_expiring_30', 'license_expiring_7', 'invoice_due', 'invoice_overdue',
             'receipt_uploaded')
  ),
  CONSTRAINT ck_license_reminders_recipients CHECK (recipients >= 0)
);

-- ---------------------------------------------------------------------------------------------------
-- 7. Settings: how long a quote is valid, when an invoice falls due
-- ---------------------------------------------------------------------------------------------------

-- The bank details (license.bank.*) are inserted by the console when the super admin first saves
-- them: a text setting cannot be empty, and an invented placeholder would be printed on invoices.
INSERT INTO app.platform_settings (key, description, value_type, integer_value, sensitivity, is_mutable)
VALUES
  ('license.quote_validity_days', 'Days a license quote stays open for the school to accept.',
   'integer', 30, 'internal', true),
  ('license.invoice_due_days', 'Days after issue that a license invoice falls due.',
   'integer', 30, 'internal', true)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------
-- 8. Privileges and tenant isolation
-- ---------------------------------------------------------------------------------------------------

-- Pricing and numbering are the super admin's: studafy_admin only.
REVOKE ALL PRIVILEGES ON TABLE
  app.license_price_settings, app.license_price_brackets, app.license_invoice_counters
FROM PUBLIC, studafy_app;

-- The school reads its quotes, invoices, payments and receipts; accepting a quote updates it and
-- issues the invoice and its lines; it uploads receipts. Payments are recorded by the super admin
-- only. No DELETE anywhere: quotes close by status, invoices and payments are voided.
REVOKE ALL PRIVILEGES ON TABLE
  app.license_quotes, app.license_invoices, app.license_invoice_lines, app.license_payments,
  app.license_payment_receipts, app.license_reminders
FROM PUBLIC, studafy_app;
GRANT SELECT, UPDATE ON TABLE app.license_quotes TO studafy_app;
GRANT SELECT, INSERT ON TABLE app.license_invoices, app.license_invoice_lines TO studafy_app;
GRANT SELECT ON TABLE app.license_payments TO studafy_app;
GRANT SELECT, INSERT ON TABLE app.license_payment_receipts TO studafy_app;

REVOKE ALL ON FUNCTION
  app.next_license_invoice_number(date),
  app.license_payments_before_update()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.next_license_invoice_number(date) TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'license_quotes');
SELECT app.apply_tenant_isolation('app', 'license_invoices');
SELECT app.apply_tenant_isolation('app', 'license_invoice_lines');
SELECT app.apply_tenant_isolation('app', 'license_payments');
SELECT app.apply_tenant_isolation('app', 'license_payment_receipts');
SELECT app.apply_tenant_isolation('app', 'license_reminders');

COMMENT ON TABLE app.license_price_settings IS
  'License pricing per currency: how volume discounts are counted. Global, super admin only.';
COMMENT ON TABLE app.license_price_brackets IS
  'Volume (by seats) and duration (by months) discount brackets of a currency''s license pricing.';
COMMENT ON TABLE app.license_invoice_counters IS
  'The gapless license invoice number sequence, per year (app.next_license_invoice_number).';
COMMENT ON TABLE app.license_quotes IS
  'A priced license offer to a school: terms, the calculator''s breakdown, total and validity.';
COMMENT ON TABLE app.license_invoices IS
  'What a school owes for an accepted license quote, paid by bank transfer against payment_reference.';
COMMENT ON TABLE app.license_invoice_lines IS
  'License invoice lines: seats per audience, overlap credits, the manual adjustment.';
COMMENT ON TABLE app.license_payments IS
  'Bank transfers recorded against license invoices. Voided with a reason, never deleted.';
COMMENT ON TABLE app.license_payment_receipts IS
  'Transfer receipts a school uploaded, pending until matched to a recorded payment.';
COMMENT ON TABLE app.license_reminders IS
  'License and invoice reminders the workers have sent, one per kind and subject.';

RESET ROLE;
