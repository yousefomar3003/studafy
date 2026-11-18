-- Student AI revenue share, owner's rules of 2026-11-18 (docs/billing/ai-programme.md):
--
-- 1. Conversion is measured every MONTH, not once per licence period: one locked snapshot per
--    licence month (period_start = the month's first day), counting the students the school
--    provides Student AI to that month (opt-ins and assigned seats) over enrolled students. The
--    snapshot table already allows one locked row per (licence, period_start); nothing changes in it.
--
-- 2. A payment's share is recorded per MONTH it pays for: an instalment that pays for several months
--    (yearly, at once, custom) gets one ledger entry per month, each under that month's conversion.
--    The one-share-per-payment-and-instalment index becomes one per payment, instalment and month.
--
-- 3. Nothing is credited or paid out before a super admin approves it. A share whose figures are
--    final now waits in `awaiting_approval` (stamped `final_at`, the moment it became final, which
--    puts it on that week's statement) instead of going straight to owed / payout due; a super admin
--    approves it (owed or payout_due by the programme's payout mode) or rejects it (`rejected`,
--    `rejected_at`: never given). Settling's credit and payout steps read only owed / payout_due, so
--    they never touch a share awaiting approval; its forfeiture step now covers those too.
--
--    Shares already final but not yet given when this applies (owed / payout_due, never credited or
--    paid) are moved to awaiting_approval: the programme went live on 2026-11-18, and no share may
--    leave without approval. Reversals (negative, taking back a share already given) keep their
--    status: they only ever reduce what Studafy pays.

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Ledger: one share per payment, instalment and month
-- ---------------------------------------------------------------------------------------------------

DROP INDEX app.uq_ai_programme_revenue_share_entries_share;
CREATE UNIQUE INDEX uq_ai_programme_revenue_share_entries_share
  ON app.ai_programme_revenue_share_entries (school_id, payment_id, instalment_id, period_from)
  WHERE kind = 'share';

-- ---------------------------------------------------------------------------------------------------
-- 2. Ledger: awaiting approval, rejected
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.ai_programme_revenue_share_entries
  ADD COLUMN final_at timestamptz,
  ADD COLUMN rejected_at timestamptz;

ALTER TABLE app.ai_programme_revenue_share_entries
  DROP CONSTRAINT ck_ai_programme_revenue_share_entries_status;
ALTER TABLE app.ai_programme_revenue_share_entries
  ADD CONSTRAINT ck_ai_programme_revenue_share_entries_status CHECK (
    CASE status
      WHEN 'pending' THEN kind = 'share' AND (conversion_pending OR bonus_pending)
      WHEN 'awaiting_approval' THEN kind = 'share' AND NOT conversion_pending AND NOT bonus_pending
      WHEN 'owed' THEN NOT conversion_pending AND NOT bonus_pending
      WHEN 'zero' THEN kind = 'share' AND amount_minor = 0 AND NOT conversion_pending
        AND NOT bonus_pending
      WHEN 'credited' THEN NOT conversion_pending AND NOT bonus_pending
      WHEN 'payout_due' THEN NOT conversion_pending AND NOT bonus_pending
      WHEN 'paid_out' THEN NOT conversion_pending AND NOT bonus_pending
      WHEN 'forfeited' THEN kind = 'share'
      WHEN 'void' THEN kind = 'share'
      WHEN 'rejected' THEN kind = 'share' AND NOT conversion_pending AND NOT bonus_pending
      ELSE false
    END
    AND (status <> 'awaiting_approval' OR final_at IS NOT NULL)
    AND (status <> 'pending' OR final_at IS NULL)
    AND (status = 'rejected') = (rejected_at IS NOT NULL)
    AND (status = 'credited') = (credit_invoice_id IS NOT NULL)
    AND (credit_invoice_id IS NULL) = (credited_at IS NULL)
    AND (status = 'paid_out') = (payout_id IS NOT NULL)
    AND (status = 'forfeited') = (forfeited_at IS NOT NULL)
    AND (forfeited_at IS NULL) = (forfeit_reason IS NULL)
    AND (forfeit_reason IS NULL OR forfeit_reason IN ('late_payment', 'unpaid_at_cutoff'))
    AND (status = 'void') = (voided_at IS NOT NULL)
  );

-- Shares final but not yet given wait for approval (see the header). The ledger trigger refuses
-- owed -> awaiting_approval by design, so it is set aside for this one statement only.
ALTER TABLE app.ai_programme_revenue_share_entries
  DISABLE TRIGGER trg_ai_programme_revenue_share_entries_before_update;
UPDATE app.ai_programme_revenue_share_entries
SET status = 'awaiting_approval', final_at = computed_at,
    updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
WHERE kind = 'share' AND status IN ('owed', 'payout_due');
ALTER TABLE app.ai_programme_revenue_share_entries
  ENABLE TRIGGER trg_ai_programme_revenue_share_entries_before_update;

-- What an entry is about never changes; its figures change only while it is pending; its status
-- moves only forward. A final share now passes through awaiting_approval before it can be given.
CREATE OR REPLACE FUNCTION app.ai_programme_revenue_share_entries_before_update()
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
          NEW.bonus_pending, NEW.computed_at, NEW.final_at)
         IS DISTINCT FROM
         (OLD.snapshot_id, OLD.seats, OLD.conversion_bps, OLD.conversion_share_bps,
          OLD.floor_applied, OLD.upload_consistency_bps, OLD.bonus_bps, OLD.capped,
          OLD.multiplier_bps, OLD.total_bps, OLD.amount_minor, OLD.conversion_pending,
          OLD.bonus_pending, OLD.computed_at, OLD.final_at)
  THEN
    RAISE EXCEPTION 'a final revenue share cannot be recomputed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_ai_programme_revenue_share_entries_ledger',
            TABLE = 'ai_programme_revenue_share_entries', SCHEMA = 'app';
  END IF;

  allowed := CASE OLD.status
    WHEN 'pending' THEN NEW.status IN ('pending', 'awaiting_approval', 'zero', 'forfeited', 'void')
    WHEN 'awaiting_approval' THEN NEW.status IN ('awaiting_approval', 'owed', 'payout_due',
                                                 'rejected', 'forfeited', 'void')
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
              NEW.forfeit_reason, NEW.voided_at, NEW.rejected_at)
             IS DISTINCT FROM
             (OLD.credit_invoice_id, OLD.credited_at, OLD.payout_id, OLD.forfeited_at,
              OLD.forfeit_reason, OLD.voided_at, OLD.rejected_at))
  THEN
    RAISE EXCEPTION 'a revenue share entry cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_ai_programme_revenue_share_entries_ledger',
            TABLE = 'ai_programme_revenue_share_entries', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

-- Shares awaiting approval, by the moment they became final: the weekly statement's read.
CREATE INDEX idx_ai_programme_revenue_share_entries_awaiting
  ON app.ai_programme_revenue_share_entries (school_id, final_at)
  WHERE status = 'awaiting_approval';

-- ---------------------------------------------------------------------------------------------------
-- 3. Settling: shares awaiting approval are forfeited like any share not yet given
-- ---------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.settle_ai_revenue_share(as_of date)
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
  -- yet given are forfeited -- those awaiting approval too (000250).
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
      AND e.status IN ('pending', 'awaiting_approval', 'owed', 'payout_due')
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
  'Forfeits, credits and moves to payout the armed school''s approved Student AI revenue shares as of a day (000237, 000250); returns every change for the caller to audit.';

COMMENT ON TABLE app.ai_programme_conversion_snapshots IS
  'Student AI conversion measured for a licence month: enrolled, students with Student AI from the school, the tier share; the scheduled one is locked (000237, 000250).';
COMMENT ON TABLE app.ai_programme_revenue_share_entries IS
  'The Student AI revenue share ledger: one entry per recorded payment, instalment and month, with its figures and status; final shares await a super admin''s approval (000237, 000250).';

RESET ROLE;
