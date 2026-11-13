SET ROLE studafy_admin;

CREATE TABLE app.expense_cache (
  id                   uuid DEFAULT gen_random_uuid()
                         CONSTRAINT pk_expense_cache PRIMARY KEY,
  school_id            uuid NOT NULL,
  document_type        text NOT NULL,
  category             text NOT NULL,
  vendor               text NOT NULL,
  description          text,
  currency_id          uuid NOT NULL,
  amount_minor         bigint NOT NULL,
  erpnext_docname      text NOT NULL,
  erpnext_status       text NOT NULL,
  attachment_storage_key text,
  erpnext_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  expense_date         date NOT NULL DEFAULT CURRENT_DATE,
  last_synced_at       timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_expense_cache_school_erpnext_docname
    UNIQUE (school_id, erpnext_docname),

  CONSTRAINT fk_expense_cache_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_expense_cache_currency
    FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_expense_cache_document_type CHECK (
    document_type IN ('purchase_invoice', 'expense_claim', 'journal_entry')
  ),

  CONSTRAINT ck_expense_cache_erpnext_docname CHECK (
    erpnext_docname = btrim(erpnext_docname) AND erpnext_docname <> ''
  ),

  CONSTRAINT ck_expense_cache_erpnext_status CHECK (
    erpnext_status = btrim(erpnext_status) AND erpnext_status <> ''
  ),

  CONSTRAINT ck_expense_cache_category CHECK (
    category = btrim(category) AND category <> ''
  ),

  CONSTRAINT ck_expense_cache_vendor CHECK (
    vendor = btrim(vendor) AND vendor <> ''
  ),

  CONSTRAINT ck_expense_cache_amount CHECK (amount_minor > 0),

  CONSTRAINT ck_expense_cache_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_expense_cache_lookup
  ON app.expense_cache (school_id, document_type, category, expense_date);

CREATE INDEX idx_expense_cache_monthly
  ON app.expense_cache (school_id, expense_date)
  INCLUDE (amount_minor, category);

CREATE INDEX idx_expense_cache_docname
  ON app.expense_cache (school_id, erpnext_docname);

REVOKE ALL PRIVILEGES ON TABLE app.expense_cache FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.expense_cache TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'expense_cache');

RESET ROLE;
