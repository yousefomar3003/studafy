-- Licence invoice payment plans: pay at once, monthly, or on a custom schedule.
--
-- The super admin chooses how a licence is paid when pricing the quote (docs/adr/0021): at once
-- (as before), monthly over the licence term, or a custom schedule of amounts and dates that add up
-- to the total. The invoice an accepted quote issues is split into instalments:
--
--   * app.license_quotes.payment_plan / payment_schedule -- the plan offered, and for `custom` the
--     super admin's amounts and dates (JSONB: a proposal only; what is owed is relational below).
--   * app.license_invoices.payment_plan                  -- the plan the invoice is paid on.
--   * app.license_invoice_instalments                    -- what is due when: amount, due date, how
--     much of it is paid, its status, when it went overdue, and its own online payment link.
--
-- One invoice per quote and the gapless invoice numbers are unchanged. The invoice's paid total is
-- still the sum of its payments; it is spread over the instalments earliest first by the API on every
-- payment and every void (@studafy/license-pricing allocatePayments). The invoice's due date is its
-- earliest unpaid instalment's. The licence activates once the first instalment is paid in full.
--
-- A deferred constraint trigger keeps every invoice whole at commit: its instalments add up to its
-- total, their paid amounts to its paid amount, and their due dates never go backwards.
--
-- Every existing invoice becomes a single instalment with the invoice's own id, amount, due date,
-- overdue mark and payment link (000220), so the reminders already sent for it (app.license_reminders,
-- keyed by subject id) are not sent again. app.license_invoices.payment_link is kept for the API
-- still running during the deploy and is no longer written.
--
-- Depends on 000165 (licence billing), 000220 (invoice payment link).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. The plan on quotes and invoices
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.license_quotes
  ADD COLUMN payment_plan text NOT NULL DEFAULT 'in_full',
  ADD COLUMN payment_schedule jsonb;

ALTER TABLE app.license_quotes
  ADD CONSTRAINT ck_license_quotes_payment_plan CHECK (
    payment_plan IN ('in_full', 'monthly', 'custom')
  ),
  ADD CONSTRAINT ck_license_quotes_payment_schedule CHECK (
    (payment_plan = 'custom') = (payment_schedule IS NOT NULL)
    AND (payment_schedule IS NULL OR jsonb_typeof(payment_schedule) = 'array')
  );

COMMENT ON COLUMN app.license_quotes.payment_plan IS
  'How the invoice this quote issues is paid: in_full, monthly over the licence months, or custom (000221).';
COMMENT ON COLUMN app.license_quotes.payment_schedule IS
  'For a custom plan, the super admin''s instalments: [{"amountMinor": n, "dueDate": "YYYY-MM-DD"}], adding up to total_minor (000221).';

ALTER TABLE app.license_invoices
  ADD COLUMN payment_plan text NOT NULL DEFAULT 'in_full';

ALTER TABLE app.license_invoices
  ADD CONSTRAINT ck_license_invoices_payment_plan CHECK (
    payment_plan IN ('in_full', 'monthly', 'custom')
  );

COMMENT ON COLUMN app.license_invoices.payment_link IS
  'Superseded by app.license_invoice_instalments.payment_link (000221); kept for the API running during that deploy, no longer written.';

-- ---------------------------------------------------------------------------------------------------
-- 2. app.license_invoice_instalments
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.license_invoice_instalments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_license_invoice_instalments PRIMARY KEY,
  school_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  -- 1, 2, 3 ... in due-date order.
  position integer NOT NULL,
  amount_minor bigint NOT NULL,
  -- The part of the invoice's payments that falls on this instalment (earliest first).
  paid_minor bigint NOT NULL DEFAULT 0,
  balance_minor bigint GENERATED ALWAYS AS (amount_minor - paid_minor) STORED,
  due_date date NOT NULL,
  status text NOT NULL,
  -- Set by the workers when the due date passes while it is not paid; kept once paid, as history.
  overdue_at timestamptz,
  -- An online payment link (Revolut) for this instalment's amount, pasted by the super admin.
  payment_link text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_license_invoice_instalments_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_license_invoice_instalments_position UNIQUE (school_id, invoice_id, position),
  CONSTRAINT fk_license_invoice_instalments_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_invoice_instalments_invoice FOREIGN KEY (invoice_id, school_id)
    REFERENCES app.license_invoices (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_invoice_instalments_position CHECK (position >= 1),
  CONSTRAINT ck_license_invoice_instalments_amounts CHECK (
    amount_minor >= 0 AND paid_minor >= 0 AND paid_minor <= amount_minor
  ),
  CONSTRAINT ck_license_invoice_instalments_status CHECK (
    CASE status
      WHEN 'due' THEN paid_minor = 0 AND amount_minor > 0
      WHEN 'partially_paid' THEN paid_minor > 0 AND paid_minor < amount_minor
      WHEN 'paid' THEN paid_minor = amount_minor
      ELSE false
    END
  ),
  CONSTRAINT ck_license_invoice_instalments_payment_link CHECK (
    payment_link IS NULL
    OR (payment_link ~ '^https://[^[:space:]]+$' AND char_length(payment_link) <= 500)
  ),
  CONSTRAINT ck_license_invoice_instalments_timestamps CHECK (updated_at >= created_at)
);

-- An invoice's instalments in order: the invoice page, allocation, and the current instalment.
CREATE INDEX idx_license_invoice_instalments_school_invoice
  ON app.license_invoice_instalments (school_id, invoice_id, position);
-- The overdue scan: unpaid instalments by due date.
CREATE INDEX idx_license_invoice_instalments_school_unpaid_due
  ON app.license_invoice_instalments (school_id, due_date)
  WHERE status <> 'paid';

COMMENT ON TABLE app.license_invoice_instalments IS
  'What a licence invoice is paid in, and when (000221): amounts adding up to the invoice total, each with its due date, paid part, status, overdue mark and online payment link.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Every invoice stays whole: checked at commit
-- ---------------------------------------------------------------------------------------------------

CREATE FUNCTION app.check_license_invoice_instalments()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  previous_school text := pg_catalog.current_setting('app.school_id', true);
  target_invoice uuid;
  target_school uuid;
  invoice_total bigint;
  invoice_paid bigint;
  instalments integer;
  amount_sum bigint;
  paid_sum bigint;
  backwards integer;
BEGIN
  IF TG_TABLE_NAME = 'license_invoices' THEN
    target_invoice := NEW.id;
  ELSE
    target_invoice := NEW.invoice_id;
  END IF;
  target_school := NEW.school_id;

  -- Deferred to commit, so the transaction may be scoped to another school by then (a super admin's
  -- audit row is written in their home school): read this invoice's school, then restore the scope.
  PERFORM pg_catalog.set_config('app.school_id', target_school::text, true);

  SELECT total_minor, paid_minor INTO invoice_total, invoice_paid
  FROM app.license_invoices
  WHERE id = target_invoice AND school_id = target_school;

  SELECT count(*), COALESCE(sum(amount_minor), 0), COALESCE(sum(paid_minor), 0)
  INTO instalments, amount_sum, paid_sum
  FROM app.license_invoice_instalments
  WHERE invoice_id = target_invoice AND school_id = target_school;

  SELECT count(*) INTO backwards
  FROM (
    SELECT due_date < lag(due_date) OVER (ORDER BY position) AS back
    FROM app.license_invoice_instalments
    WHERE invoice_id = target_invoice AND school_id = target_school
  ) AS ordered
  WHERE back;

  PERFORM pg_catalog.set_config('app.school_id', COALESCE(previous_school, ''), true);

  IF instalments = 0 OR amount_sum <> invoice_total OR paid_sum <> invoice_paid OR backwards > 0 THEN
    RAISE EXCEPTION 'licence invoice % is not whole: % instalments of % (total %), % paid (invoice %), % out of order',
      target_invoice, instalments, amount_sum, invoice_total, paid_sum, invoice_paid, backwards
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ck_license_invoice_instalments_whole';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_license_invoices_instalments_whole
  AFTER INSERT OR UPDATE OF total_minor, paid_minor ON app.license_invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_license_invoice_instalments();

CREATE CONSTRAINT TRIGGER trg_license_invoice_instalments_whole
  AFTER INSERT OR UPDATE OF amount_minor, paid_minor, due_date, position
  ON app.license_invoice_instalments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_license_invoice_instalments();

-- ---------------------------------------------------------------------------------------------------
-- 4. Existing invoices: one instalment each, with the invoice's own id
-- ---------------------------------------------------------------------------------------------------

DO $backfill$
DECLARE
  candidate uuid;
BEGIN
  -- School by school: the invoices are tenant-isolated.
  FOR candidate IN SELECT school.id FROM app.schools AS school ORDER BY school.id LOOP
    PERFORM pg_catalog.set_config('app.school_id', candidate::text, true);
    INSERT INTO app.license_invoice_instalments (
      id, school_id, invoice_id, position, amount_minor, paid_minor, due_date, status, overdue_at,
      payment_link, created_at, updated_at
    )
    SELECT
      i.id, i.school_id, i.id, 1, i.total_minor, i.paid_minor, i.due_date,
      CASE
        WHEN i.paid_minor = i.total_minor THEN 'paid'
        WHEN i.paid_minor > 0 THEN 'partially_paid'
        ELSE 'due'
      END,
      i.overdue_at, i.payment_link, i.created_at, GREATEST(i.updated_at, i.created_at)
    FROM app.license_invoices AS i
    WHERE i.school_id = candidate;
  END LOOP;
  PERFORM pg_catalog.set_config('app.school_id', '', true);
END
$backfill$;

-- ---------------------------------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.license_invoice_instalments FROM PUBLIC, studafy_app;
-- A school accepting a quote issues the invoice and its instalments; every later change (payments,
-- links, due dates, overdue marks) is the super admin's or the workers', as studafy_admin.
GRANT SELECT, INSERT ON TABLE app.license_invoice_instalments TO studafy_app;

REVOKE ALL ON FUNCTION app.check_license_invoice_instalments() FROM PUBLIC;

SELECT app.apply_tenant_isolation('app', 'license_invoice_instalments');

RESET ROLE;
