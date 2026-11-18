-- Student AI: collected student-months and weekly statements (owner's rules of 2026-11-18,
-- docs/billing/ai-programme.md "Weekly statements"):
--
-- * A parent opt-in's Student AI months are on the parent's tuition (phase 3). Once the tuition
--   invoice carrying a portion of them is paid in full, the school has collected those months: one
--   `student_ai_months` row per student and month, priced at what the school owes Studafy for it
--   (the licence's programme seat price).
--
-- * Every week a statement per school and currency gathers the student-months collected that week
--   (what the school owes Studafy, less its revenue share on them) and the school's licence shares
--   that became final that week (awaiting approval since 000250). A super admin approves, holds or
--   rejects it. Approved, Studafy issues a licence invoice for the net (`kind = 'ai_statement'`,
--   lines `student_ai_months` and the share as a credit); when the school pays it, those
--   student-months are activated. Rejected, its months go back for the next statement and its
--   licence shares are rejected.
--
-- * A statement invoice never stops or starts a licence: an unpaid one only leaves its months
--   inactive. `license_invoices.kind` tells the two kinds apart.

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

-- The super admins' notice that a week's statements are waiting for them (in-app and push).
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'AI_REVENUE_SHARE_STATEMENTS_READY';

-- ---------------------------------------------------------------------------------------------------
-- 1. Licence invoices: a statement invoice, and its student-months line
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.license_invoices
  ADD COLUMN kind text NOT NULL DEFAULT 'licence',
  ADD CONSTRAINT ck_license_invoices_kind CHECK (kind IN ('licence', 'ai_statement'));

COMMENT ON COLUMN app.license_invoices.kind IS
  'licence: seats and terms (quotes); ai_statement: a Student AI weekly statement''s net, which never starts or stops a licence (000251).';

ALTER TABLE app.license_invoice_lines DROP CONSTRAINT ck_license_invoice_lines_kind;
ALTER TABLE app.license_invoice_lines
  ADD CONSTRAINT ck_license_invoice_lines_kind CHECK (
    kind IN ('seats', 'overlap_credit', 'adjustment', 'ai_share_credit', 'student_ai_months')
  ),
  ADD CONSTRAINT ck_license_invoice_lines_student_ai_months CHECK (
    kind <> 'student_ai_months' OR amount_minor > 0
  );

COMMENT ON COLUMN app.license_invoice_lines.kind IS
  'seats, overlap_credit, adjustment, ai_share_credit (Student AI revenue share credited, 000237), or student_ai_months (the parent opt-in months a weekly statement bills, 000251).';

-- ---------------------------------------------------------------------------------------------------
-- 2. Weekly statements
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_programme_weekly_statements (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_programme_weekly_statements PRIMARY KEY,
  school_id uuid NOT NULL,
  -- The Monday the week starts on, and its Sunday (UTC dates).
  week_start date NOT NULL,
  week_end date NOT NULL,
  currency_id uuid NOT NULL,
  -- The collected student-months: what the school owes Studafy for them, its share on them, the net.
  months_count integer NOT NULL,
  gross_minor bigint NOT NULL,
  share_minor bigint NOT NULL,
  net_minor bigint NOT NULL,
  -- The school's licence shares (school-assigned seats) that became final that week.
  licence_share_count integer NOT NULL,
  licence_share_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_approval',
  decided_at timestamptz,
  -- The super admin (home-school user, no FK).
  decided_by uuid,
  decision_note text,
  -- The licence invoice issued for the net when it was approved (none when there was nothing to bill).
  invoice_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ai_programme_weekly_statements_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_ai_programme_weekly_statements_week UNIQUE (school_id, week_start, currency_id),
  CONSTRAINT fk_ai_programme_weekly_statements_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_weekly_statements_currency FOREIGN KEY (currency_id)
    REFERENCES app.currencies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_weekly_statements_invoice FOREIGN KEY (invoice_id, school_id)
    REFERENCES app.license_invoices (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_programme_weekly_statements_week CHECK (
    extract(isodow FROM week_start) = 1 AND week_end = week_start + 6
  ),
  CONSTRAINT ck_ai_programme_weekly_statements_figures CHECK (
    months_count >= 0 AND gross_minor >= 0 AND share_minor >= 0 AND share_minor <= gross_minor
    AND net_minor = gross_minor - share_minor
    AND licence_share_count >= 0 AND licence_share_minor >= 0
    AND (months_count > 0 OR licence_share_count > 0)
  ),
  CONSTRAINT ck_ai_programme_weekly_statements_status CHECK (
    CASE status
      WHEN 'awaiting_approval' THEN decided_at IS NULL AND decided_by IS NULL
        AND decision_note IS NULL AND invoice_id IS NULL
      WHEN 'held' THEN decided_at IS NOT NULL AND decided_by IS NOT NULL
        AND decision_note IS NOT NULL AND invoice_id IS NULL
      WHEN 'approved' THEN decided_at IS NOT NULL AND decided_by IS NOT NULL
      WHEN 'rejected' THEN decided_at IS NOT NULL AND decided_by IS NOT NULL
        AND decision_note IS NOT NULL AND invoice_id IS NULL
      ELSE false
    END
  ),
  CONSTRAINT ck_ai_programme_weekly_statements_note CHECK (
    decision_note IS NULL
    OR (decision_note = btrim(decision_note) AND decision_note <> ''
        AND char_length(decision_note) <= 1000)
  ),
  CONSTRAINT ck_ai_programme_weekly_statements_timestamps CHECK (updated_at >= created_at)
);

-- Statements waiting for a decision, across schools: the console's queue.
CREATE INDEX idx_ai_programme_weekly_statements_status
  ON app.ai_programme_weekly_statements (status, week_start DESC);

-- What a statement is for and its figures never change; its status moves forward only.
CREATE FUNCTION app.ai_programme_weekly_statements_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF (NEW.school_id, NEW.week_start, NEW.week_end, NEW.currency_id, NEW.months_count,
      NEW.gross_minor, NEW.share_minor, NEW.net_minor, NEW.licence_share_count,
      NEW.licence_share_minor, NEW.created_at)
     IS DISTINCT FROM
     (OLD.school_id, OLD.week_start, OLD.week_end, OLD.currency_id, OLD.months_count,
      OLD.gross_minor, OLD.share_minor, OLD.net_minor, OLD.licence_share_count,
      OLD.licence_share_minor, OLD.created_at)
  THEN
    RAISE EXCEPTION 'a weekly statement''s figures cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_ai_programme_weekly_statements_ledger',
            TABLE = 'ai_programme_weekly_statements', SCHEMA = 'app';
  END IF;
  IF NOT (
    CASE OLD.status
      WHEN 'awaiting_approval' THEN NEW.status IN ('held', 'approved', 'rejected')
      WHEN 'held' THEN NEW.status IN ('held', 'approved', 'rejected')
      -- Approved: only its invoice is linked, once.
      WHEN 'approved' THEN NEW.status = 'approved' AND OLD.invoice_id IS NULL
        AND (NEW.decided_at, NEW.decided_by, NEW.decision_note)
            IS NOT DISTINCT FROM (OLD.decided_at, OLD.decided_by, OLD.decision_note)
      ELSE false
    END
  ) THEN
    RAISE EXCEPTION 'a weekly statement cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_ai_programme_weekly_statements_ledger',
            TABLE = 'ai_programme_weekly_statements', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_ai_programme_weekly_statements_before_update
  BEFORE UPDATE ON app.ai_programme_weekly_statements
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_weekly_statements_before_update();

CREATE TRIGGER trg_ai_programme_weekly_statements_no_delete
  BEFORE DELETE ON app.ai_programme_weekly_statements
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_revenue_share_reject_change();

-- The school's licence shares a statement gathered.
ALTER TABLE app.ai_programme_revenue_share_entries
  ADD COLUMN statement_id uuid,
  ADD CONSTRAINT fk_ai_programme_revenue_share_entries_statement
    FOREIGN KEY (statement_id, school_id)
    REFERENCES app.ai_programme_weekly_statements (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE INDEX idx_ai_programme_revenue_share_entries_statement
  ON app.ai_programme_revenue_share_entries (school_id, statement_id)
  WHERE statement_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- 3. Collected student-months
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.student_ai_fee_portions
  ADD CONSTRAINT uq_student_ai_fee_portions_id_school UNIQUE (id, school_id);

CREATE TABLE app.student_ai_months (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_ai_months PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  optin_id uuid NOT NULL,
  license_id uuid NOT NULL,
  -- The first day of the month of Student AI it is for.
  month date NOT NULL,
  -- The tuition portion whose invoice the parent paid.
  portion_id uuid NOT NULL,
  -- What the school owes Studafy for the month: the licence's programme seat price, its currency.
  currency_id uuid NOT NULL,
  price_minor bigint NOT NULL,
  -- The day Studafy saw the parent's tuition invoice paid in full (UTC).
  collected_on date NOT NULL,
  -- The weekly statement it is on; its share there (the conversion of the month it was collected).
  statement_id uuid,
  share_bps integer,
  share_minor bigint,
  -- collected: waiting for (or on) a statement; billed: on an approved statement's invoice;
  -- activated: the school paid that invoice, the student has Student AI that month; void: the
  -- parent's invoice was cancelled before it was billed.
  status text NOT NULL DEFAULT 'collected',
  billed_at timestamptz,
  activated_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_student_ai_months_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_student_ai_months_student_month UNIQUE (school_id, student_id, month),
  CONSTRAINT fk_student_ai_months_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_months_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_months_optin FOREIGN KEY (optin_id, school_id)
    REFERENCES app.ai_optins (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_months_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_months_portion FOREIGN KEY (portion_id, school_id)
    REFERENCES app.student_ai_fee_portions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_months_currency FOREIGN KEY (currency_id)
    REFERENCES app.currencies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_months_statement FOREIGN KEY (statement_id, school_id)
    REFERENCES app.ai_programme_weekly_statements (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_ai_months_month CHECK (extract(day FROM month) = 1),
  CONSTRAINT ck_student_ai_months_price CHECK (price_minor >= 0),
  CONSTRAINT ck_student_ai_months_share CHECK (
    (statement_id IS NULL) = (share_bps IS NULL)
    AND (share_bps IS NULL) = (share_minor IS NULL)
    AND (share_bps IS NULL OR share_bps BETWEEN 0 AND 10000)
    AND (share_minor IS NULL OR share_minor BETWEEN 0 AND price_minor)
  ),
  CONSTRAINT ck_student_ai_months_status CHECK (
    CASE status
      WHEN 'collected' THEN billed_at IS NULL AND activated_at IS NULL AND voided_at IS NULL
      WHEN 'billed' THEN statement_id IS NOT NULL AND billed_at IS NOT NULL
        AND activated_at IS NULL AND voided_at IS NULL
      WHEN 'activated' THEN statement_id IS NOT NULL AND billed_at IS NOT NULL
        AND activated_at IS NOT NULL AND voided_at IS NULL
      WHEN 'void' THEN statement_id IS NULL AND voided_at IS NOT NULL
      ELSE false
    END
  ),
  CONSTRAINT ck_student_ai_months_timestamps CHECK (updated_at >= created_at)
);

-- The months waiting for a statement, and a statement's months.
CREATE INDEX idx_student_ai_months_collected
  ON app.student_ai_months (school_id, collected_on)
  WHERE status = 'collected' AND statement_id IS NULL;
CREATE INDEX idx_student_ai_months_statement
  ON app.student_ai_months (school_id, statement_id)
  WHERE statement_id IS NOT NULL;
CREATE INDEX idx_student_ai_months_portion ON app.student_ai_months (school_id, portion_id);
CREATE INDEX idx_student_ai_months_optin ON app.student_ai_months (school_id, optin_id);
CREATE INDEX idx_student_ai_months_license ON app.student_ai_months (school_id, license_id);

-- What a month is for never changes; it moves collected -> billed -> activated (or collected ->
-- void). A billed month goes back to collected only when its statement invoice is voided unpaid;
-- a collected month leaves a statement only when the statement is rejected.
CREATE FUNCTION app.student_ai_months_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF (NEW.school_id, NEW.student_id, NEW.optin_id, NEW.license_id, NEW.month, NEW.portion_id,
      NEW.currency_id, NEW.price_minor, NEW.collected_on, NEW.created_at)
     IS DISTINCT FROM
     (OLD.school_id, OLD.student_id, OLD.optin_id, OLD.license_id, OLD.month, OLD.portion_id,
      OLD.currency_id, OLD.price_minor, OLD.collected_on, OLD.created_at)
  THEN
    RAISE EXCEPTION 'what a Student AI month is for cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_student_ai_months_ledger',
            TABLE = 'student_ai_months', SCHEMA = 'app';
  END IF;
  IF NOT (
    CASE OLD.status
      WHEN 'collected' THEN NEW.status IN ('collected', 'billed', 'void')
      WHEN 'billed' THEN NEW.status IN ('billed', 'activated', 'collected')
      ELSE NEW.status = OLD.status
        AND (NEW.statement_id, NEW.share_bps, NEW.share_minor, NEW.billed_at, NEW.activated_at,
             NEW.voided_at)
            IS NOT DISTINCT FROM
            (OLD.statement_id, OLD.share_bps, OLD.share_minor, OLD.billed_at, OLD.activated_at,
             OLD.voided_at)
    END
  ) THEN
    RAISE EXCEPTION 'a Student AI month cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_student_ai_months_ledger',
            TABLE = 'student_ai_months', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_student_ai_months_before_update
  BEFORE UPDATE ON app.student_ai_months
  FOR EACH ROW EXECUTE FUNCTION app.student_ai_months_before_update();

CREATE TRIGGER trg_student_ai_months_no_delete
  BEFORE DELETE ON app.student_ai_months
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_revenue_share_reject_change();

-- ---------------------------------------------------------------------------------------------------
-- 4. Privileges and row-level security
-- ---------------------------------------------------------------------------------------------------

-- The workers and the API write as studafy_admin; the runtime role reads its own school's rows.
REVOKE ALL PRIVILEGES ON TABLE
  app.ai_programme_weekly_statements, app.student_ai_months
FROM PUBLIC, studafy_app;
GRANT SELECT ON TABLE
  app.ai_programme_weekly_statements, app.student_ai_months
TO studafy_app;

REVOKE ALL ON FUNCTION
  app.ai_programme_weekly_statements_before_update(),
  app.student_ai_months_before_update()
FROM PUBLIC;

SELECT app.apply_tenant_isolation('app', 'ai_programme_weekly_statements');
SELECT app.apply_tenant_isolation('app', 'student_ai_months');

-- A family sees its own children's months (whether each is active); leadership sees all.
CREATE POLICY role_scope_visibility ON app.student_ai_months
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.current_user_is_school_admin() OR app.is_related_to_student(student_id));

COMMENT ON TABLE app.ai_programme_weekly_statements IS
  'A school''s Student AI weekly statement: the opt-in months it collected that week (owed to Studafy, less its share) and its licence shares that became final; a super admin approves, holds or rejects it (000251).';
COMMENT ON TABLE app.student_ai_months IS
  'One student''s month of Student AI the school collected from the parent (the tuition invoice paid in full): billed on a weekly statement, activated once the school pays it (000251).';

RESET ROLE;
