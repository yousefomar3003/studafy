-- The Student AI revenue share engine: phase 5 of "Student AI seats bundled with tuition, plus
-- revenue share" (approved 2026-11-17; docs/billing/ai-programme.md, "Revenue share engine").
--
-- Studafy pays a school a share of what it collects for Student AI seats: a conversion share (the
-- tier of students opted in / enrolled, measured on a set day and then locked) plus a content bonus
-- (how consistently teachers upload over the days a payment covers), capped, and scaled for a
-- month-to-month licence. Every number comes from the programme values the licence was signed with
-- (000234). The arithmetic is @studafy/license-pricing computeRevenueShare.
--
-- ## Tables
--
--   * app.ai_programme_conversion_snapshots  -- a conversion measurement of one licence period:
--     students enrolled and opted in on a day, the conversion and the tier share it gives. The
--     workers take the period's measurement on its measurement day (the period's first day + the
--     licence's measurement_offset_days) and lock it; the super admin may re-measure before that
--     (with a reason, audited) to see where a school stands. A licence period is the licence's term
--     from its start, or the months an extension (a renewal) adds. Rows are immutable; one locked
--     row per licence period, and nothing is measured for a period once it is locked.
--   * app.ai_programme_revenue_share_entries -- the ledger: one entry per recorded payment and
--     instalment it paid (the money collected for the period that instalment pays for), with the
--     programme versions, the conversion, bonus, cap and multiplier used, the share in basis points
--     and the amount. An entry is never deleted and its figures never change once final.
--   * app.ai_programme_revenue_share_payouts -- a payout of shares the super admin recorded (paid
--     outside Studafy, with the bank reference). Immutable.
--
-- ## An entry's life
--
--   pending    -- conversion is not locked yet, or the upload consistency for its period is not known
--                 yet: its figures are provisional and are worked out again when they are.
--   owed       -- final; to be credited on the school's next licence invoice.
--   zero       -- final, and 0 (a conversion under the first tier, a month-to-month licence earning
--                 0%): recorded so every payment has its line, with nothing to give.
--   credited   -- taken off that invoice (credit_invoice_id): an `ai_share_credit` invoice line, the
--                 invoice total and its unpaid instalments (earliest first) reduced by the amount, so
--                 the balance, the due date, the overdue marks and the AI stop all follow. If that
--                 invoice is voided (nothing was paid on it), the share is owed again.
--   payout_due -- to be paid out: the licence's values say payout, or the licence ended with no open
--                 invoice to credit it on.
--   paid_out   -- in a recorded payout (payout_id).
--   forfeited  -- the instalment it is for was not paid by its cutoff (its due date + the licence's
--                 grace days, the day Student AI stops for non-payment; decision 11): the share for
--                 that period is lost, whether the entry is for money paid before the cutoff (a part
--                 payment) or after it (the late rest). Shares already credited or paid out stay so.
--   void       -- its payment was voided before the share was given. A share already credited or paid
--                 out is taken back by a `reversal` entry (negative), netted against the next credit
--                 or payout.
--
-- app.settle_ai_revenue_share(as_of) does the moves that need no new figures, for the armed school:
-- forfeiture, crediting owed shares on open invoices issued after the share's own invoice (the
-- earliest first, never more than an invoice's unpaid balance), and owed -> payout_due once the
-- licence has ended. It is SECURITY DEFINER so a school accepting a quote (studafy_app, which may not
-- update invoices) gets its credit on the invoice that acceptance issues; it acts only on the armed
-- school's rows (FORCE RLS binds its owner) and returns every change for the caller to audit. The API
-- calls it after a payment is recorded or voided and after an invoice is issued; the workers' hourly
-- licence lifecycle job calls it for every school.
--
-- ## Tenancy and access
--
-- All three tables carry school_id, the canonical tenant policy, school-leading keys and composite
-- foreign keys. The runtime role (studafy_app) reads them (the school's own credits); only
-- studafy_admin -- the super admin's console and the workers -- writes them. Snapshots and payouts
-- reject UPDATE and DELETE; entries reject DELETE, and a trigger allows only the status moves above.
--
-- Depends on 000163 (licences), 000165 and 000221 (invoices, payments, instalments), 000234
-- (programme versions).

-- The FK validation scans read tables with forced RLS: a non-matching tenant context lets them run
-- (as in 000168 and 000233).
SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Conversion snapshots
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_programme_conversion_snapshots (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_programme_conversion_snapshots PRIMARY KEY,
  school_id uuid NOT NULL,
  license_id uuid NOT NULL,
  -- The licence period measured: the licence's start, or the first day an extension adds.
  period_start date NOT NULL,
  -- period_start + the licence's measurement_offset_days: when the tier is measured and locked.
  measure_on date NOT NULL,
  -- The day the counts are for: measure_on for the locked one, the day of a super admin's re-measure.
  as_of date NOT NULL,
  enrolled_count integer NOT NULL,
  opted_in_count integer NOT NULL,
  -- opted_in / enrolled in basis points, rounded down (0 with nobody enrolled, at most 10000).
  conversion_bps integer NOT NULL,
  -- Student seats on the licence that day (the large-school floor's test).
  seats integer NOT NULL,
  -- The tier share the conversion gives under the values below, the floor applied.
  conversion_share_bps integer NOT NULL,
  floor_applied boolean NOT NULL,
  ai_programme_version_id uuid NOT NULL,
  ai_programme_override_id uuid,
  locked boolean NOT NULL,
  -- scheduled: the workers, on the measurement day. super_admin: a re-measure before the lock.
  source text NOT NULL,
  reason text,
  -- The super admin (a user of their own home school, no FK, as in 000163).
  measured_by uuid,
  measured_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ai_programme_conversion_snapshots_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_ai_programme_conversion_snapshots_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_conversion_snapshots_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_conversion_snapshots_version FOREIGN KEY (ai_programme_version_id)
    REFERENCES app.ai_programme_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_conversion_snapshots_override
    FOREIGN KEY (ai_programme_override_id, school_id)
    REFERENCES app.ai_programme_school_overrides (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_programme_conversion_snapshots_counts CHECK (
    enrolled_count >= 0 AND opted_in_count >= 0 AND seats >= 0
    AND conversion_bps BETWEEN 0 AND 10000
    AND conversion_share_bps BETWEEN 0 AND 10000
  ),
  CONSTRAINT ck_ai_programme_conversion_snapshots_dates CHECK (
    measure_on >= period_start AND (NOT locked OR as_of = measure_on)
  ),
  CONSTRAINT ck_ai_programme_conversion_snapshots_source CHECK (
    CASE source
      WHEN 'scheduled' THEN locked AND measured_by IS NULL AND reason IS NULL
      WHEN 'super_admin' THEN NOT locked AND measured_by IS NOT NULL AND reason IS NOT NULL
      ELSE false
    END
  ),
  CONSTRAINT ck_ai_programme_conversion_snapshots_reason CHECK (
    reason IS NULL OR (reason = btrim(reason) AND reason <> '' AND char_length(reason) <= 1000)
  )
);

-- One locked measurement per licence period.
CREATE UNIQUE INDEX uq_ai_programme_conversion_snapshots_locked
  ON app.ai_programme_conversion_snapshots (school_id, license_id, period_start)
  WHERE locked;
-- A licence's measurements, newest first.
CREATE INDEX idx_ai_programme_conversion_snapshots_school_license
  ON app.ai_programme_conversion_snapshots (school_id, license_id, period_start, measured_at DESC);
CREATE INDEX idx_ai_programme_conversion_snapshots_school_override
  ON app.ai_programme_conversion_snapshots (school_id, ai_programme_override_id)
  WHERE ai_programme_override_id IS NOT NULL;

-- Nothing is measured for a period once it is locked: the tier holds for the whole period.
CREATE FUNCTION app.ai_programme_conversion_snapshots_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.ai_programme_conversion_snapshots AS s
    WHERE s.school_id = NEW.school_id AND s.license_id = NEW.license_id
      AND s.period_start = NEW.period_start AND s.locked
  ) THEN
    RAISE EXCEPTION 'the conversion of this licence period is locked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_ai_programme_conversion_snapshots_locked',
            TABLE = 'ai_programme_conversion_snapshots', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_ai_programme_conversion_snapshots_before_insert
  BEFORE INSERT ON app.ai_programme_conversion_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_conversion_snapshots_before_insert();

CREATE FUNCTION app.ai_programme_revenue_share_reject_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER trg_ai_programme_conversion_snapshots_immutable
  BEFORE UPDATE OR DELETE ON app.ai_programme_conversion_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_revenue_share_reject_change();

-- ---------------------------------------------------------------------------------------------------
-- 2. Payouts
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_programme_revenue_share_payouts (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_programme_revenue_share_payouts PRIMARY KEY,
  school_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  -- The net of the entries it pays (a reversal entry nets against it).
  amount_minor bigint NOT NULL,
  -- The bank's (or provider's) reference for the transfer to the school.
  reference text NOT NULL,
  paid_on date NOT NULL,
  note text,
  -- The super admin (home-school user, no FK).
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ai_programme_revenue_share_payouts_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_ai_programme_revenue_share_payouts_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_payouts_currency FOREIGN KEY (currency_id)
    REFERENCES app.currencies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_programme_revenue_share_payouts_amount CHECK (amount_minor > 0),
  CONSTRAINT ck_ai_programme_revenue_share_payouts_reference CHECK (
    reference = btrim(reference) AND reference <> '' AND char_length(reference) <= 200
  ),
  CONSTRAINT ck_ai_programme_revenue_share_payouts_note CHECK (
    note IS NULL OR (note = btrim(note) AND note <> '' AND char_length(note) <= 1000)
  )
);

CREATE INDEX idx_ai_programme_revenue_share_payouts_school_paid
  ON app.ai_programme_revenue_share_payouts (school_id, paid_on DESC);

CREATE TRIGGER trg_ai_programme_revenue_share_payouts_immutable
  BEFORE UPDATE OR DELETE ON app.ai_programme_revenue_share_payouts
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_revenue_share_reject_change();

-- ---------------------------------------------------------------------------------------------------
-- 3. The ledger
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_programme_revenue_share_entries (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_programme_revenue_share_entries PRIMARY KEY,
  school_id uuid NOT NULL,
  -- share: on a payment's part of one instalment. reversal: takes back a share already credited or
  -- paid out whose payment was voided (negative amounts).
  kind text NOT NULL DEFAULT 'share',
  reverses_entry_id uuid,
  license_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  instalment_id uuid NOT NULL,
  -- The day the payment was received (UTC): against the instalment's cutoff for forfeiture.
  received_on date NOT NULL,
  -- The days the instalment pays for (inclusive): the content bonus is measured over them.
  period_from date NOT NULL,
  period_to date NOT NULL,
  -- The licence period whose conversion counts (app.ai_programme_conversion_snapshots.period_start).
  measurement_period_start date NOT NULL,
  currency_id uuid NOT NULL,
  -- What the payment put on this instalment, and the Student AI part of it (in proportion to the
  -- invoice's student seat lines among its seat lines).
  collected_minor bigint NOT NULL,
  base_minor bigint NOT NULL,
  commitment text NOT NULL,
  -- The programme values the licence was signed with when the payment was recorded.
  ai_programme_version_id uuid NOT NULL,
  ai_programme_override_id uuid,
  -- The locked measurement used; NULL while conversion is pending.
  snapshot_id uuid,
  seats integer,
  conversion_bps integer,
  conversion_share_bps integer NOT NULL,
  floor_applied boolean NOT NULL,
  upload_consistency_bps integer,
  bonus_bps integer NOT NULL,
  capped boolean NOT NULL,
  multiplier_bps integer NOT NULL,
  total_bps integer NOT NULL,
  amount_minor bigint NOT NULL,
  conversion_pending boolean NOT NULL,
  bonus_pending boolean NOT NULL,
  status text NOT NULL,
  -- When the figures were worked out (last, while pending).
  computed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  credit_invoice_id uuid,
  credited_at timestamptz,
  payout_id uuid,
  forfeited_at timestamptz,
  -- late_payment: recorded after the instalment's cutoff. unpaid_at_cutoff: the instalment was not
  -- paid by its cutoff.
  forfeit_reason text,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ai_programme_revenue_share_entries_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_ai_programme_revenue_share_entries_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_reverses FOREIGN KEY (reverses_entry_id, school_id)
    REFERENCES app.ai_programme_revenue_share_entries (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_invoice FOREIGN KEY (invoice_id, school_id)
    REFERENCES app.license_invoices (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_payment FOREIGN KEY (payment_id, school_id)
    REFERENCES app.license_payments (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_instalment FOREIGN KEY (instalment_id, school_id)
    REFERENCES app.license_invoice_instalments (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_currency FOREIGN KEY (currency_id)
    REFERENCES app.currencies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_version FOREIGN KEY (ai_programme_version_id)
    REFERENCES app.ai_programme_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_override
    FOREIGN KEY (ai_programme_override_id, school_id)
    REFERENCES app.ai_programme_school_overrides (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_snapshot FOREIGN KEY (snapshot_id, school_id)
    REFERENCES app.ai_programme_conversion_snapshots (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_credit_invoice
    FOREIGN KEY (credit_invoice_id, school_id)
    REFERENCES app.license_invoices (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_revenue_share_entries_payout FOREIGN KEY (payout_id, school_id)
    REFERENCES app.ai_programme_revenue_share_payouts (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_programme_revenue_share_entries_kind CHECK (
    CASE kind
      WHEN 'share' THEN reverses_entry_id IS NULL AND collected_minor > 0 AND base_minor >= 0
        AND base_minor <= collected_minor AND amount_minor >= 0
      WHEN 'reversal' THEN reverses_entry_id IS NOT NULL AND collected_minor < 0
        AND base_minor <= 0 AND base_minor >= collected_minor AND amount_minor <= 0
      ELSE false
    END
  ),
  CONSTRAINT ck_ai_programme_revenue_share_entries_period CHECK (period_to >= period_from),
  CONSTRAINT ck_ai_programme_revenue_share_entries_commitment CHECK (
    commitment IN ('full_year', 'month_to_month')
  ),
  CONSTRAINT ck_ai_programme_revenue_share_entries_bps CHECK (
    (conversion_bps IS NULL OR conversion_bps BETWEEN 0 AND 10000)
    AND (upload_consistency_bps IS NULL OR upload_consistency_bps BETWEEN 0 AND 10000)
    AND (seats IS NULL OR seats >= 0)
    AND conversion_share_bps BETWEEN 0 AND 10000
    AND bonus_bps BETWEEN 0 AND 10000
    AND multiplier_bps BETWEEN 0 AND 10000
    AND total_bps BETWEEN 0 AND 10000
  ),
  CONSTRAINT ck_ai_programme_revenue_share_entries_conversion CHECK (
    conversion_pending = (snapshot_id IS NULL)
    AND (snapshot_id IS NULL) = (conversion_bps IS NULL)
    AND (snapshot_id IS NULL) = (seats IS NULL)
  ),
  CONSTRAINT ck_ai_programme_revenue_share_entries_status CHECK (
    CASE status
      WHEN 'pending' THEN kind = 'share' AND (conversion_pending OR bonus_pending)
      WHEN 'owed' THEN NOT conversion_pending AND NOT bonus_pending
      WHEN 'zero' THEN kind = 'share' AND amount_minor = 0 AND NOT conversion_pending
        AND NOT bonus_pending
      WHEN 'credited' THEN NOT conversion_pending AND NOT bonus_pending
      WHEN 'payout_due' THEN NOT conversion_pending AND NOT bonus_pending
      WHEN 'paid_out' THEN NOT conversion_pending AND NOT bonus_pending
      WHEN 'forfeited' THEN kind = 'share'
      WHEN 'void' THEN kind = 'share'
      ELSE false
    END
    AND (status = 'credited') = (credit_invoice_id IS NOT NULL)
    AND (credit_invoice_id IS NULL) = (credited_at IS NULL)
    AND (status = 'paid_out') = (payout_id IS NOT NULL)
    AND (status = 'forfeited') = (forfeited_at IS NOT NULL)
    AND (forfeited_at IS NULL) = (forfeit_reason IS NULL)
    AND (forfeit_reason IS NULL OR forfeit_reason IN ('late_payment', 'unpaid_at_cutoff'))
    AND (status = 'void') = (voided_at IS NOT NULL)
  ),
  CONSTRAINT ck_ai_programme_revenue_share_entries_timestamps CHECK (updated_at >= created_at)
);

-- One share per payment and instalment; one reversal per share.
CREATE UNIQUE INDEX uq_ai_programme_revenue_share_entries_share
  ON app.ai_programme_revenue_share_entries (school_id, payment_id, instalment_id)
  WHERE kind = 'share';
CREATE UNIQUE INDEX uq_ai_programme_revenue_share_entries_reversal
  ON app.ai_programme_revenue_share_entries (school_id, reverses_entry_id)
  WHERE kind = 'reversal';
-- A school's ledger by status (settling, totals) and per licence (the console).
CREATE INDEX idx_ai_programme_revenue_share_entries_school_status
  ON app.ai_programme_revenue_share_entries (school_id, status, computed_at);
CREATE INDEX idx_ai_programme_revenue_share_entries_school_license
  ON app.ai_programme_revenue_share_entries (school_id, license_id, received_on DESC);
CREATE INDEX idx_ai_programme_revenue_share_entries_school_instalment
  ON app.ai_programme_revenue_share_entries (school_id, instalment_id);
CREATE INDEX idx_ai_programme_revenue_share_entries_school_invoice
  ON app.ai_programme_revenue_share_entries (school_id, invoice_id);
CREATE INDEX idx_ai_programme_revenue_share_entries_school_credit_invoice
  ON app.ai_programme_revenue_share_entries (school_id, credit_invoice_id)
  WHERE credit_invoice_id IS NOT NULL;
CREATE INDEX idx_ai_programme_revenue_share_entries_school_payout
  ON app.ai_programme_revenue_share_entries (school_id, payout_id)
  WHERE payout_id IS NOT NULL;
CREATE INDEX idx_ai_programme_revenue_share_entries_school_snapshot
  ON app.ai_programme_revenue_share_entries (school_id, snapshot_id)
  WHERE snapshot_id IS NOT NULL;
CREATE INDEX idx_ai_programme_revenue_share_entries_school_override
  ON app.ai_programme_revenue_share_entries (school_id, ai_programme_override_id)
  WHERE ai_programme_override_id IS NOT NULL;

-- What an entry is about never changes; its figures change only while it is pending; its status
-- moves only forward, along the life described at the top.
CREATE FUNCTION app.ai_programme_revenue_share_entries_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  allowed boolean;
BEGIN
  IF (NEW.school_id, NEW.kind, NEW.reverses_entry_id, NEW.license_id, NEW.invoice_id,
      NEW.payment_id, NEW.instalment_id, NEW.received_on, NEW.period_from, NEW.period_to,
      NEW.measurement_period_start, NEW.currency_id, NEW.collected_minor, NEW.base_minor,
      NEW.commitment, NEW.ai_programme_version_id, NEW.ai_programme_override_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.school_id, OLD.kind, OLD.reverses_entry_id, OLD.license_id, OLD.invoice_id,
      OLD.payment_id, OLD.instalment_id, OLD.received_on, OLD.period_from, OLD.period_to,
      OLD.measurement_period_start, OLD.currency_id, OLD.collected_minor, OLD.base_minor,
      OLD.commitment, OLD.ai_programme_version_id, OLD.ai_programme_override_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'what a revenue share entry is for cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_ai_programme_revenue_share_entries_ledger',
            TABLE = 'ai_programme_revenue_share_entries', SCHEMA = 'app';
  END IF;

  IF OLD.status <> 'pending'
     AND (NEW.snapshot_id, NEW.seats, NEW.conversion_bps, NEW.conversion_share_bps,
          NEW.floor_applied, NEW.upload_consistency_bps, NEW.bonus_bps, NEW.capped,
          NEW.multiplier_bps, NEW.total_bps, NEW.amount_minor, NEW.conversion_pending,
          NEW.bonus_pending, NEW.computed_at)
         IS DISTINCT FROM
         (OLD.snapshot_id, OLD.seats, OLD.conversion_bps, OLD.conversion_share_bps,
          OLD.floor_applied, OLD.upload_consistency_bps, OLD.bonus_bps, OLD.capped,
          OLD.multiplier_bps, OLD.total_bps, OLD.amount_minor, OLD.conversion_pending,
          OLD.bonus_pending, OLD.computed_at)
  THEN
    RAISE EXCEPTION 'a final revenue share cannot be recomputed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_ai_programme_revenue_share_entries_ledger',
            TABLE = 'ai_programme_revenue_share_entries', SCHEMA = 'app';
  END IF;

  allowed := CASE OLD.status
    WHEN 'pending' THEN NEW.status IN ('pending', 'owed', 'zero', 'payout_due', 'forfeited', 'void')
    WHEN 'zero' THEN NEW.status IN ('zero', 'void')
    WHEN 'owed' THEN NEW.status IN ('owed', 'credited', 'payout_due', 'forfeited', 'void')
    -- The invoice it was credited on was voided: owed again, for the next one.
    WHEN 'credited' THEN NEW.status IN ('credited', 'owed')
    WHEN 'payout_due' THEN NEW.status IN ('payout_due', 'paid_out', 'forfeited', 'void')
    ELSE NEW.status = OLD.status
  END;
  IF NOT allowed
     OR (OLD.status = NEW.status AND OLD.status <> 'pending'
         AND (NEW.credit_invoice_id, NEW.credited_at, NEW.payout_id, NEW.forfeited_at,
              NEW.forfeit_reason, NEW.voided_at)
             IS DISTINCT FROM
             (OLD.credit_invoice_id, OLD.credited_at, OLD.payout_id, OLD.forfeited_at,
              OLD.forfeit_reason, OLD.voided_at))
  THEN
    RAISE EXCEPTION 'a revenue share entry cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_ai_programme_revenue_share_entries_ledger',
            TABLE = 'ai_programme_revenue_share_entries', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_ai_programme_revenue_share_entries_before_update
  BEFORE UPDATE ON app.ai_programme_revenue_share_entries
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_revenue_share_entries_before_update();

CREATE TRIGGER trg_ai_programme_revenue_share_entries_no_delete
  BEFORE DELETE ON app.ai_programme_revenue_share_entries
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_revenue_share_reject_change();

-- ---------------------------------------------------------------------------------------------------
-- 4. The credit line on an invoice
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.license_invoice_lines DROP CONSTRAINT ck_license_invoice_lines_kind;
ALTER TABLE app.license_invoice_lines
  ADD CONSTRAINT ck_license_invoice_lines_kind CHECK (
    kind IN ('seats', 'overlap_credit', 'adjustment', 'ai_share_credit')
  ),
  ADD CONSTRAINT ck_license_invoice_lines_ai_share_credit CHECK (
    kind <> 'ai_share_credit' OR amount_minor < 0
  );

COMMENT ON COLUMN app.license_invoice_lines.kind IS
  'seats, overlap_credit, adjustment, or ai_share_credit: Student AI revenue share credited on this invoice (000237); its entries name the invoice in credit_invoice_id.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Settling: forfeit, credit, payout due
-- ---------------------------------------------------------------------------------------------------

CREATE FUNCTION app.settle_ai_revenue_share(as_of date)
RETURNS TABLE (entry_id uuid, from_status text, to_status text, invoice_id uuid, amount_minor bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
#variable_conflict use_column
DECLARE
  school uuid := NULLIF(pg_catalog.current_setting('app.school_id', true), '')::uuid;
  candidate record;
  owed record;
  slot record;
  available bigint;
  running bigint;
  chosen uuid[];
  left_over bigint;
  cut bigint;
  next_amount bigint;
  next_total bigint;
  next_due date;
  next_position integer;
BEGIN
  IF school IS NULL OR as_of IS NULL THEN
    RAISE EXCEPTION 'settling the revenue share needs a school and a day' USING ERRCODE = '22023';
  END IF;

  -- 1. Forfeiture (decision 11). An instalment is forfeit once it was not paid in full by its cutoff:
  -- still unpaid on or after the cutoff, or settled by money received on or after it. Its shares not
  -- yet given are forfeited.
  RETURN QUERY
  WITH forfeit AS (
    SELECT inst.id
    FROM app.license_invoice_instalments AS inst
    JOIN app.license_invoices AS i ON i.id = inst.invoice_id AND i.school_id = inst.school_id
    JOIN app.school_licenses AS l ON l.id = i.license_id AND l.school_id = i.school_id
    WHERE inst.school_id = school
      AND i.status <> 'void'
      AND (
        (inst.status <> 'paid' AND inst.due_date + l.nonpayment_grace_days <= as_of)
        OR EXISTS (
          SELECT 1 FROM app.ai_programme_revenue_share_entries AS late
          WHERE late.school_id = inst.school_id AND late.instalment_id = inst.id
            AND late.kind = 'share'
            AND late.received_on >= inst.due_date + l.nonpayment_grace_days
        )
      )
  ),
  targets AS (
    SELECT e.id, e.status
    FROM app.ai_programme_revenue_share_entries AS e
    WHERE e.school_id = school
      AND e.kind = 'share'
      AND e.status IN ('pending', 'owed', 'payout_due')
      AND e.instalment_id IN (SELECT forfeit.id FROM forfeit)
    FOR UPDATE
  ),
  done AS (
    UPDATE app.ai_programme_revenue_share_entries AS e
    SET status = 'forfeited', forfeited_at = CURRENT_TIMESTAMP, forfeit_reason = 'unpaid_at_cutoff',
        updated_at = GREATEST(CURRENT_TIMESTAMP, e.updated_at)
    FROM targets
    WHERE e.school_id = school AND e.id = targets.id
    RETURNING e.id, targets.status AS before, e.amount_minor
  )
  SELECT done.id, done.before, 'forfeited'::text, NULL::uuid, done.amount_minor FROM done;

  -- 2. Credit owed shares on open invoices issued after their own, the earliest invoice first,
  -- never more than an invoice's unpaid balance. Reversals (negative) are netted in first.
  FOR candidate IN
    SELECT i.id, i.currency_id, i.created_at, i.total_minor, i.paid_minor
    FROM app.license_invoices AS i
    WHERE i.school_id = school
      AND i.status IN ('issued', 'partially_paid')
      AND EXISTS (
        SELECT 1
        FROM app.ai_programme_revenue_share_entries AS e
        JOIN app.license_invoices AS src ON src.id = e.invoice_id AND src.school_id = e.school_id
        WHERE e.school_id = school AND e.status = 'owed' AND e.currency_id = i.currency_id
          AND src.created_at < i.created_at
      )
    ORDER BY i.issue_date, i.created_at, i.id
    FOR UPDATE OF i
  LOOP
    available := candidate.total_minor - candidate.paid_minor;
    running := 0;
    chosen := ARRAY[]::uuid[];
    FOR owed IN
      SELECT e.id, e.amount_minor
      FROM app.ai_programme_revenue_share_entries AS e
      JOIN app.license_invoices AS src ON src.id = e.invoice_id AND src.school_id = e.school_id
      WHERE e.school_id = school AND e.status = 'owed' AND e.currency_id = candidate.currency_id
        AND src.created_at < candidate.created_at
      ORDER BY (e.amount_minor < 0) DESC, e.computed_at, e.id
      FOR UPDATE OF e
    LOOP
      IF owed.amount_minor <= 0 OR running + owed.amount_minor <= available THEN
        running := running + owed.amount_minor;
        chosen := chosen || owed.id;
      END IF;
    END LOOP;
    CONTINUE WHEN running <= 0;

    SELECT COALESCE(max(line.position), 0) + 1 INTO next_position
    FROM app.license_invoice_lines AS line
    WHERE line.school_id = school AND line.invoice_id = candidate.id;
    INSERT INTO app.license_invoice_lines (
      school_id, invoice_id, position, kind, description, amount_minor
    ) VALUES (
      school, candidate.id, next_position, 'ai_share_credit', 'Student AI revenue share credit', -running
    );

    -- The unpaid instalments carry the credit, earliest first: what is due soonest goes down first.
    left_over := running;
    FOR slot IN
      SELECT inst.id, inst.amount_minor, inst.paid_minor
      FROM app.license_invoice_instalments AS inst
      WHERE inst.school_id = school AND inst.invoice_id = candidate.id
      ORDER BY inst.position
      FOR UPDATE
    LOOP
      EXIT WHEN left_over = 0;
      cut := LEAST(left_over, slot.amount_minor - slot.paid_minor);
      CONTINUE WHEN cut <= 0;
      next_amount := slot.amount_minor - cut;
      UPDATE app.license_invoice_instalments AS inst
      SET amount_minor = next_amount,
          status = CASE
            WHEN slot.paid_minor = next_amount THEN 'paid'
            WHEN slot.paid_minor > 0 THEN 'partially_paid'
            ELSE 'due'
          END,
          updated_at = GREATEST(CURRENT_TIMESTAMP, inst.updated_at)
      WHERE inst.school_id = school AND inst.id = slot.id;
      left_over := left_over - cut;
    END LOOP;

    next_total := candidate.total_minor - running;
    SELECT COALESCE(
      (SELECT inst.due_date FROM app.license_invoice_instalments AS inst
       WHERE inst.school_id = school AND inst.invoice_id = candidate.id AND inst.status <> 'paid'
       ORDER BY inst.position LIMIT 1),
      (SELECT inst.due_date FROM app.license_invoice_instalments AS inst
       WHERE inst.school_id = school AND inst.invoice_id = candidate.id
       ORDER BY inst.position DESC LIMIT 1)
    ) INTO next_due;

    UPDATE app.license_invoices AS i
    SET credit_total_minor = i.credit_total_minor + running,
        total_minor = next_total,
        status = CASE
          WHEN i.paid_minor = next_total THEN 'paid'
          WHEN i.paid_minor > 0 THEN 'partially_paid'
          ELSE 'issued'
        END,
        due_date = next_due,
        overdue_at = CASE WHEN next_due >= as_of THEN NULL ELSE i.overdue_at END,
        updated_at = GREATEST(CURRENT_TIMESTAMP, i.updated_at)
    WHERE i.school_id = school AND i.id = candidate.id;

    RETURN QUERY
    UPDATE app.ai_programme_revenue_share_entries AS e
    SET status = 'credited', credit_invoice_id = candidate.id, credited_at = CURRENT_TIMESTAMP,
        updated_at = GREATEST(CURRENT_TIMESTAMP, e.updated_at)
    WHERE e.school_id = school AND e.id = ANY(chosen)
    RETURNING e.id, 'owed'::text, 'credited'::text, candidate.id, e.amount_minor;
  END LOOP;

  -- 3. A licence that has ended has no next invoice for what is still owed: it is paid out.
  RETURN QUERY
  WITH ended AS (
    SELECT e.id
    FROM app.ai_programme_revenue_share_entries AS e
    JOIN app.school_licenses AS l ON l.id = e.license_id AND l.school_id = e.school_id
    WHERE e.school_id = school AND e.status = 'owed'
      AND (l.status IN ('expired', 'cancelled') OR (l.ends_at AT TIME ZONE 'UTC')::date <= as_of)
    FOR UPDATE OF e
  ),
  done AS (
    UPDATE app.ai_programme_revenue_share_entries AS e
    SET status = 'payout_due', updated_at = GREATEST(CURRENT_TIMESTAMP, e.updated_at)
    FROM ended
    WHERE e.school_id = school AND e.id = ended.id
    RETURNING e.id, e.amount_minor
  )
  SELECT done.id, 'owed'::text, 'payout_due'::text, NULL::uuid, done.amount_minor FROM done;
END
$function$;

COMMENT ON FUNCTION app.settle_ai_revenue_share(date) IS
  'Forfeits, credits and moves to payout the armed school''s Student AI revenue shares as of a day (000237); returns every change for the caller to audit.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Access and tenant isolation
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE
  app.ai_programme_conversion_snapshots, app.ai_programme_revenue_share_entries,
  app.ai_programme_revenue_share_payouts
FROM PUBLIC, studafy_app;
-- The school reads its own measurements, shares and payouts; only studafy_admin writes them.
GRANT SELECT ON TABLE
  app.ai_programme_conversion_snapshots, app.ai_programme_revenue_share_entries,
  app.ai_programme_revenue_share_payouts
TO studafy_app;

REVOKE ALL ON FUNCTION
  app.ai_programme_conversion_snapshots_before_insert(),
  app.ai_programme_revenue_share_reject_change(),
  app.ai_programme_revenue_share_entries_before_update(),
  app.settle_ai_revenue_share(date)
FROM PUBLIC;
-- Accepting a quote issues an invoice the school's owed shares are credited on.
GRANT EXECUTE ON FUNCTION app.settle_ai_revenue_share(date) TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'ai_programme_conversion_snapshots');
SELECT app.apply_tenant_isolation('app', 'ai_programme_revenue_share_payouts');
SELECT app.apply_tenant_isolation('app', 'ai_programme_revenue_share_entries');

COMMENT ON TABLE app.ai_programme_conversion_snapshots IS
  'Student AI conversion measured for a licence period: enrolled, opted in, the tier share; the scheduled one is locked (000237).';
COMMENT ON TABLE app.ai_programme_revenue_share_entries IS
  'The Student AI revenue share ledger: one entry per recorded payment and instalment, with its figures and status (000237).';
COMMENT ON TABLE app.ai_programme_revenue_share_payouts IS
  'Revenue share payouts to a school the super admin recorded, with the transfer reference (000237).';

RESET ROLE;
