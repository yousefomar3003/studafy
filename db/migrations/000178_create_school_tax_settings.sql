-- A school's sales tax (VAT) on fees: off unless the school turns it on. Studafy does not decide
-- whether fees are taxable; that depends on the country and the fee (in the UAE core tuition is
-- zero-rated and some other fees are standard-rated; Saudi Arabia charges VAT on private schooling
-- for non-citizens). The school sets one rate, the ERPNext tax account it posts to, its tax
-- registration number for invoices and receipts, and the fee categories the rate does not apply to.
--
-- Applied when an invoice is generated (the worker adds an ERPNext "On Net Total" tax row and
-- zero-rates the exempt categories' lines), never to invoices already issued: a tax change is a new
-- invoice's business, an issued one is corrected with a credit note.

SET ROLE studafy_admin;

CREATE TABLE app.school_tax_settings (
  school_id uuid CONSTRAINT pk_school_tax_settings PRIMARY KEY,
  is_enabled boolean NOT NULL DEFAULT false,
  -- What the invoice line says: "VAT", "ضريبة القيمة المضافة".
  tax_name text NOT NULL DEFAULT 'VAT',
  rate numeric(5, 2) NOT NULL DEFAULT 0,
  -- The ERPNext Account the tax posts to, e.g. 'VAT 5% - SCH'. Required once enabled.
  erpnext_account_head text,
  -- Shown on invoices and receipts (a UAE TRN, a Saudi VAT number).
  registration_number text,
  -- Fees are quoted before tax unless this is set, in which case the rate is carved out of them.
  prices_include_tax boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_school_tax_settings_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_school_tax_settings_updated_by FOREIGN KEY (updated_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_school_tax_settings_rate CHECK (rate >= 0 AND rate <= 100),
  CONSTRAINT ck_school_tax_settings_tax_name CHECK (
    tax_name = btrim(tax_name) AND tax_name <> '' AND length(tax_name) <= 60
  ),
  CONSTRAINT ck_school_tax_settings_account CHECK (
    erpnext_account_head IS NULL
    OR (erpnext_account_head = btrim(erpnext_account_head) AND erpnext_account_head <> '')
  ),
  CONSTRAINT ck_school_tax_settings_registration CHECK (
    registration_number IS NULL
    OR (registration_number = btrim(registration_number) AND registration_number <> ''
        AND length(registration_number) <= 40)
  ),
  -- Enabled means something to post: a positive rate and an account to post it to.
  CONSTRAINT ck_school_tax_settings_enabled CHECK (
    NOT is_enabled OR (rate > 0 AND erpnext_account_head IS NOT NULL)
  ),
  CONSTRAINT ck_school_tax_settings_timestamps CHECK (updated_at >= created_at)
);

-- Fee categories (ERPNext Item codes) the rate does not apply to: one row each, replaced as a set
-- when the settings are saved, as app.sibling_discount_tiers is.
CREATE TABLE app.school_tax_exempt_categories (
  school_id uuid NOT NULL,
  fee_category text NOT NULL,
  CONSTRAINT pk_school_tax_exempt_categories PRIMARY KEY (school_id, fee_category),
  CONSTRAINT fk_school_tax_exempt_categories_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_school_tax_exempt_categories_settings FOREIGN KEY (school_id)
    REFERENCES app.school_tax_settings (school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_school_tax_exempt_categories_fee_category CHECK (
    fee_category = btrim(fee_category) AND fee_category <> '' AND length(fee_category) <= 140
  )
);

CREATE INDEX idx_school_tax_settings_updated_by_fk
  ON app.school_tax_settings (updated_by, school_id);

REVOKE ALL PRIVILEGES ON TABLE app.school_tax_settings, app.school_tax_exempt_categories
  FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.school_tax_settings TO studafy_app;
GRANT SELECT, INSERT, DELETE ON TABLE app.school_tax_exempt_categories TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'school_tax_settings');
SELECT app.apply_tenant_isolation('app', 'school_tax_exempt_categories');

RESET ROLE;
