-- Read-model of one ERPNext Fee Structure (ST-119), populated from webhooks and gateway writes.
--
-- ERPNext owns fee structures: their validation, their currency arithmetic, and their amendment
-- rules. This table is a projection for listing and filtering in the Fee Structure Builder, never
-- a source of truth. Nothing here is derived locally -- total_amount_minor mirrors ERPNext's own
-- computed grand total, the same contract app.invoice_cache and app.fee_schedule_cache state in
-- 000015.
--
-- Two deliberate departures from the ST-119 ticket text, both to match the sibling cache tables:
--
--   1. total_amount_minor bigint + currency_id, not `total_amount numeric` + `currency text
--      DEFAULT 'JOD'`. JOD is seeded in 000005 with minor_unit = 3 -- 1000 fils, not 100 -- so a
--      column pair that hardcodes the currency string invites exactly the two-decimal assumption
--      that rounds Jordanian money wrong. The exponent belongs to app.currencies, which already
--      knows it.
--
--   2. program_erpnext_name text, not `program_id uuid`. There is no app.programs table; an ERPNext
--      Program is an ERPNext document. Storing its docname is honest about where it lives, and a
--      uuid column would reference nothing.
--
-- academic_year_id stays a real local FK because academic years DO exist here (app.academic_years),
-- and the builder filters by them.

SET ROLE studafy_admin;

CREATE TABLE app.fee_structure_cache (
  id                   uuid DEFAULT gen_random_uuid()
                         CONSTRAINT pk_fee_structure_cache PRIMARY KEY,
  school_id            uuid NOT NULL,
  academic_year_id     uuid,
  program_erpnext_name text,
  currency_id          uuid NOT NULL,
  erpnext_docname      text NOT NULL,
  erpnext_status       text NOT NULL,
  title                text NOT NULL,
  total_amount_minor   bigint NOT NULL,
  is_active            boolean NOT NULL DEFAULT true,
  erpnext_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at       timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_fee_structure_cache_school_erpnext_docname
    UNIQUE (school_id, erpnext_docname),

  CONSTRAINT fk_fee_structure_cache_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_fee_structure_cache_academic_year
    FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_fee_structure_cache_currency
    FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_fee_structure_cache_erpnext_docname CHECK (
    erpnext_docname = btrim(erpnext_docname) AND erpnext_docname <> ''
  ),

  CONSTRAINT ck_fee_structure_cache_erpnext_status CHECK (
    erpnext_status = btrim(erpnext_status) AND erpnext_status <> ''
  ),

  CONSTRAINT ck_fee_structure_cache_title CHECK (
    title = btrim(title) AND title <> ''
  ),

  CONSTRAINT ck_fee_structure_cache_program CHECK (
    program_erpnext_name IS NULL
    OR (program_erpnext_name = btrim(program_erpnext_name) AND program_erpnext_name <> '')
  ),

  CONSTRAINT ck_fee_structure_cache_amount CHECK (total_amount_minor >= 0),

  CONSTRAINT ck_fee_structure_cache_payload CHECK (
    jsonb_typeof(erpnext_payload) = 'object'
  ),

  CONSTRAINT ck_fee_structure_cache_timestamps CHECK (updated_at >= created_at)
);

-- The builder's primary query: every structure for a school, narrowed by year and program.
CREATE INDEX idx_fee_structure_cache_lookup
  ON app.fee_structure_cache (school_id, academic_year_id, program_erpnext_name);

-- studafy_app is named explicitly, not just PUBLIC: 000002 sets ALTER DEFAULT PRIVILEGES granting
-- it full DML on every table studafy_admin creates in app, so revoking from PUBLIC alone would
-- leave DELETE in place and silently contradict the line below.
REVOKE ALL PRIVILEGES ON TABLE app.fee_structure_cache FROM PUBLIC, studafy_app;
-- No DELETE: a cache row is superseded by a re-sync, never removed by the application. ERPNext
-- decides when a structure stops existing, and it says so through erpnext_status / is_active.
GRANT SELECT, INSERT, UPDATE ON TABLE app.fee_structure_cache TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'fee_structure_cache');

RESET ROLE;
