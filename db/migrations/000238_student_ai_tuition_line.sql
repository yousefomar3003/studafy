-- The Student AI line on tuition: phase 3 of "Student AI seats bundled with tuition, plus revenue
-- share" (approved 2026-11-17; docs/billing/student-ai-tuition-line.md).
--
-- For each opted-in student Studafy adds a "Student AI" fee item to the child's fees: the parent
-- price per month (the licence's signed programme values, 000234, in the school's currency) times
-- the months from the student's start month to the end of the school's academic year. The amount is
-- spread over the student's tuition instalments that fall on or after the start month, and the
-- billing worker puts each portion on the first Sales Invoice it generates for the student that is
-- due on or after the portion's due date, so ERPNext's totals, ledger and outstanding amounts carry
-- it like any other line.
--
--   * app.student_ai_billing_settings -- per school: auto-billing on (default) or off. Off: no
--                                        portions are planned (the school bills outside Studafy),
--                                        the parent still sees the line, "paid with tuition".
--                                        auto_billing_since: the first month billed through Studafy
--                                        after it was last switched back on (NULL: never off).
--   * app.student_ai_fee_items        -- per student per academic year: the price, the months
--                                        charged (start month to the year's last month, or to the
--                                        month before a released/transferred seat stops), the total.
--   * app.student_ai_fee_portions     -- the item spread over instalments: each portion covers whole
--                                        months (amount = price x months, so no rounding), planned
--                                        until an invoice carries it, then invoiced and frozen.
--
-- Items and portions are written only by the reconciliation (syncStudentAiFeeItems in the API,
-- idempotent) and the billing worker, both as studafy_admin. Planned portions are replaced freely;
-- an invoiced portion can never be changed or removed (trigger): what a parent was invoiced is the
-- school's to refund outside Studafy (decision 9).
--
-- Visibility: tenant isolation on all three; items and portions are also limited, for the runtime
-- role, to school leadership and the student's own family (app.current_user_is_school_admin,
-- app.is_related_to_student). Finance staff read them through the API's identity transaction, like
-- every other per-student finance read. Parents never see the school's licence price or revenue
-- share: neither is stored here.
--
-- Depends on 000004 (schools, currencies), 000008 (students), 000009 (academic years),
-- 000037 (role-scope helpers), 000163 (licences).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. app.student_ai_billing_settings
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.student_ai_billing_settings (
  school_id uuid NOT NULL CONSTRAINT pk_student_ai_billing_settings PRIMARY KEY,
  auto_billing boolean NOT NULL DEFAULT true,
  auto_billing_since date,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_student_ai_billing_settings_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_billing_settings_updated_by FOREIGN KEY (updated_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_ai_billing_settings_since CHECK (
    auto_billing_since IS NULL OR extract(day FROM auto_billing_since) = 1
  ),
  CONSTRAINT ck_student_ai_billing_settings_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_student_ai_billing_settings_updated_by
  ON app.student_ai_billing_settings (school_id, updated_by);

COMMENT ON TABLE app.student_ai_billing_settings IS
  'Per school: whether the Student AI line is billed on the fee schedule (default) or outside Studafy (000238).';
COMMENT ON COLUMN app.student_ai_billing_settings.auto_billing_since IS
  'First day of the first month billed through Studafy after auto-billing was last switched back on; NULL when it was never off (000238).';

-- ---------------------------------------------------------------------------------------------------
-- 2. app.student_ai_fee_items
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.student_ai_fee_items (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_ai_fee_items PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  license_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  -- The parent price per month, fixed when the item is created (what the parent agreed to).
  monthly_price_minor bigint NOT NULL,
  -- First days of months. start_month: the first month charged; end_month: the academic year's
  -- last month; stop_month: the first month no longer charged (a released or transferred seat).
  start_month date NOT NULL,
  end_month date NOT NULL,
  stop_month date,
  months smallint NOT NULL,
  total_minor bigint NOT NULL,
  -- active, or the opt-in's end: released (student left) / transferred (seat moved to another).
  status text NOT NULL DEFAULT 'active',
  -- auto: on the fee schedule; outside: the school bills it itself ("paid with tuition").
  billing text NOT NULL DEFAULT 'auto',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_student_ai_fee_items_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_student_ai_fee_items_student_year UNIQUE (school_id, student_id, academic_year_id),
  CONSTRAINT fk_student_ai_fee_items_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_fee_items_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_fee_items_academic_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_fee_items_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_fee_items_currency FOREIGN KEY (currency_id)
    REFERENCES app.currencies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_ai_fee_items_price CHECK (monthly_price_minor >= 0),
  CONSTRAINT ck_student_ai_fee_items_months CHECK (
    extract(day FROM start_month) = 1
    AND extract(day FROM end_month) = 1
    AND (stop_month IS NULL OR extract(day FROM stop_month) = 1)
    AND start_month <= end_month
    AND months BETWEEN 0 AND 24
  ),
  CONSTRAINT ck_student_ai_fee_items_total CHECK (total_minor = monthly_price_minor * months),
  CONSTRAINT ck_student_ai_fee_items_status CHECK (
    status IN ('active', 'released', 'transferred')
    AND ((status = 'active') = (stop_month IS NULL))
  ),
  CONSTRAINT ck_student_ai_fee_items_billing CHECK (billing IN ('auto', 'outside')),
  CONSTRAINT ck_student_ai_fee_items_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_student_ai_fee_items_academic_year
  ON app.student_ai_fee_items (school_id, academic_year_id);
CREATE INDEX idx_student_ai_fee_items_license
  ON app.student_ai_fee_items (school_id, license_id);
CREATE INDEX idx_student_ai_fee_items_currency ON app.student_ai_fee_items (currency_id);

COMMENT ON TABLE app.student_ai_fee_items IS
  'The Student AI line on an opted-in student''s fees for one academic year: price per month x months = total (000238).';

-- ---------------------------------------------------------------------------------------------------
-- 3. app.student_ai_fee_portions
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.student_ai_fee_portions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_ai_fee_portions PRIMARY KEY,
  school_id uuid NOT NULL,
  item_id uuid NOT NULL,
  student_id uuid NOT NULL,
  -- The instalment's due date (or the first day of the month when the student has no instalment).
  due_date date NOT NULL,
  -- The months this portion pays for: first_month and the month_count months after it.
  first_month date NOT NULL,
  month_count smallint NOT NULL,
  amount_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'planned',
  erpnext_invoice_docname text,
  invoiced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_student_ai_fee_portions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_fee_portions_item FOREIGN KEY (item_id, school_id)
    REFERENCES app.student_ai_fee_items (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_ai_fee_portions_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_ai_fee_portions_months CHECK (
    extract(day FROM first_month) = 1 AND month_count BETWEEN 1 AND 24
  ),
  CONSTRAINT ck_student_ai_fee_portions_amount CHECK (amount_minor >= 0),
  CONSTRAINT ck_student_ai_fee_portions_status CHECK (
    status IN ('planned', 'invoiced')
    AND ((status = 'invoiced') = (erpnext_invoice_docname IS NOT NULL))
    AND ((status = 'invoiced') = (invoiced_at IS NOT NULL))
  ),
  CONSTRAINT ck_student_ai_fee_portions_docname CHECK (
    erpnext_invoice_docname IS NULL
    OR (erpnext_invoice_docname = btrim(erpnext_invoice_docname) AND erpnext_invoice_docname <> '')
  ),
  CONSTRAINT ck_student_ai_fee_portions_timestamps CHECK (updated_at >= created_at)
);

-- An item's portions by due date (the reconciliation, the parent line) and the item foreign key.
CREATE INDEX idx_student_ai_fee_portions_item
  ON app.student_ai_fee_portions (school_id, item_id, due_date);
-- The billing worker's read: a student's planned portions due by an invoice's due date.
CREATE INDEX idx_student_ai_fee_portions_student_planned
  ON app.student_ai_fee_portions (school_id, student_id, due_date)
  WHERE status = 'planned';

COMMENT ON TABLE app.student_ai_fee_portions IS
  'A Student AI item spread over the student''s tuition instalments; planned until an invoice carries it, then frozen (000238).';

-- An invoiced portion is what ERPNext billed: it is never changed or removed, whoever asks.
CREATE FUNCTION app.student_ai_fee_portions_keep_invoiced()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.status = 'invoiced' THEN
    RAISE EXCEPTION 'an invoiced Student AI portion cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_student_ai_fee_portions_invoiced',
            TABLE = 'student_ai_fee_portions', SCHEMA = 'app';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app.student_ai_fee_portions_keep_invoiced() FROM PUBLIC;

CREATE TRIGGER trg_student_ai_fee_portions_keep_invoiced
  BEFORE UPDATE OR DELETE ON app.student_ai_fee_portions
  FOR EACH ROW EXECUTE FUNCTION app.student_ai_fee_portions_keep_invoiced();

-- ---------------------------------------------------------------------------------------------------
-- 4. Privileges and row-level security
-- ---------------------------------------------------------------------------------------------------

-- The reconciliation and the billing worker write as studafy_admin; the runtime role reads.
REVOKE ALL PRIVILEGES ON TABLE
  app.student_ai_billing_settings, app.student_ai_fee_items, app.student_ai_fee_portions
FROM PUBLIC, studafy_app;
GRANT SELECT ON TABLE
  app.student_ai_billing_settings, app.student_ai_fee_items, app.student_ai_fee_portions
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'student_ai_billing_settings');
SELECT app.apply_tenant_isolation('app', 'student_ai_fee_items');
SELECT app.apply_tenant_isolation('app', 'student_ai_fee_portions');

CREATE POLICY role_scope_visibility ON app.student_ai_fee_items
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.current_user_is_school_admin() OR app.is_related_to_student(student_id));

CREATE POLICY role_scope_visibility ON app.student_ai_fee_portions
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.current_user_is_school_admin() OR app.is_related_to_student(student_id));

RESET ROLE;
