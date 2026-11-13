-- Read-model of one ERPNext Scholarship/Discount config (ST-119 extension).
--
-- ERPNext owns scholarship/discount definitions: their validation, type (percentage or fixed),
-- scope (global or per fee category), and amount arithmetic. This table is a projection for
-- listing in the Scholarship Award UI, never a source of truth.
--
-- Awards follow a maker-checker workflow:
--   pending  →  confirmed  or  cancelled
-- The maker creates the award record locally; the checker confirms it, which forwards the award
-- to ERPNext. ERPNext then applies the discount to subsequent invoice generation.

SET ROLE studafy_admin;

-- Extend the entity type enum for the crosswalk table.
ALTER TYPE app.finance_entity_type ADD VALUE IF NOT EXISTS 'scholarship_discount';
ALTER TYPE app.finance_entity_type ADD VALUE IF NOT EXISTS 'award';

-- ---------------------------------------------------------------------------
-- Scholarship / Discount cache (read model from ERPNext)
-- ---------------------------------------------------------------------------

CREATE TABLE app.scholarship_discount_cache (
  id                uuid DEFAULT gen_random_uuid()
                      CONSTRAINT pk_scholarship_discount_cache PRIMARY KEY,
  school_id         uuid NOT NULL,
  erpnext_docname   text NOT NULL,
  erpnext_status    text NOT NULL,
  title             text NOT NULL,
  discount_type     text NOT NULL,
  amount            numeric NOT NULL,
  scope             text NOT NULL,
  fee_category      text,
  currency_id       uuid,
  is_active         boolean NOT NULL DEFAULT true,
  erpnext_payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at    timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_scholarship_discount_cache_school_docname
    UNIQUE (school_id, erpnext_docname),

  CONSTRAINT fk_scholarship_discount_cache_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_scholarship_discount_cache_currency
    FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_scholarship_discount_cache_erpnext_docname CHECK (
    erpnext_docname = btrim(erpnext_docname) AND erpnext_docname <> ''
  ),
  CONSTRAINT ck_scholarship_discount_cache_erpnext_status CHECK (
    erpnext_status = btrim(erpnext_status) AND erpnext_status <> ''
  ),
  CONSTRAINT ck_scholarship_discount_cache_title CHECK (
    title = btrim(title) AND title <> ''
  ),
  CONSTRAINT ck_scholarship_discount_cache_discount_type CHECK (
    discount_type IN ('percentage', 'fixed')
  ),
  CONSTRAINT ck_scholarship_discount_cache_amount CHECK (amount >= 0),
  CONSTRAINT ck_scholarship_discount_cache_scope CHECK (
    scope IN ('global', 'fee_category')
  ),
  CONSTRAINT ck_scholarship_discount_cache_payload CHECK (
    jsonb_typeof(erpnext_payload) = 'object'
  ),
  CONSTRAINT ck_scholarship_discount_cache_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_scholarship_discount_cache_lookup
  ON app.scholarship_discount_cache (school_id, is_active, scope);

CREATE INDEX idx_scholarship_discount_cache_docname
  ON app.scholarship_discount_cache (school_id, erpnext_docname);

-- ---------------------------------------------------------------------------
-- Award cache (maker-checker workflow)
-- ---------------------------------------------------------------------------

CREATE TABLE app.award_cache (
  id                      uuid DEFAULT gen_random_uuid()
                            CONSTRAINT pk_award_cache PRIMARY KEY,
  school_id               uuid NOT NULL,
  student_id              uuid NOT NULL,
  scholarship_discount_id uuid NOT NULL,
  award_status            text NOT NULL DEFAULT 'pending',
  awarded_by              uuid NOT NULL,
  confirmed_by            uuid,
  confirmed_at            timestamptz,
  erpnext_docname         text,
  erpnext_payload         jsonb,
  created_at              timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_award_cache_school_student_discount
    UNIQUE (school_id, student_id, scholarship_discount_id),

  CONSTRAINT fk_award_cache_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_award_cache_student
    FOREIGN KEY (student_id) REFERENCES app.students (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_award_cache_scholarship_discount
    FOREIGN KEY (scholarship_discount_id) REFERENCES app.scholarship_discount_cache (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_award_cache_status CHECK (
    award_status IN ('pending', 'confirmed', 'cancelled')
  ),
  CONSTRAINT ck_award_cache_erpnext_docname CHECK (
    erpnext_docname IS NULL
    OR (erpnext_docname = btrim(erpnext_docname) AND erpnext_docname <> '')
  ),
  CONSTRAINT ck_award_cache_confirmed_requires_fields CHECK (
    (award_status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
    OR (award_status <> 'confirmed')
  ),
  CONSTRAINT ck_award_cache_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_award_cache_school_status
  ON app.award_cache (school_id, award_status);

CREATE INDEX idx_award_cache_student
  ON app.award_cache (school_id, student_id, award_status);

CREATE INDEX idx_award_cache_docname
  ON app.award_cache (school_id, erpnext_docname);

-- ---------------------------------------------------------------------------
-- Permissions (same pattern as sibling cache tables)
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.scholarship_discount_cache FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.scholarship_discount_cache TO studafy_app;

REVOKE ALL PRIVILEGES ON TABLE app.award_cache FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.award_cache TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'scholarship_discount_cache');
SELECT app.apply_tenant_isolation('app', 'award_cache');

RESET ROLE;
