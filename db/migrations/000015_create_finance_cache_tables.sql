-- Creates the school-owned local read-model/cache layer for ERPNext finance data plus the
-- Studafy<->ERPNext identity crosswalk and an outbound transactional sync outbox.
--
-- ERPNext (the MariaDB plane; see docs/adr/0005-erpnext-education-plane.md) owns the double-entry
-- ledger, invoice numbering, and all balance computation. Nothing in this migration models a
-- ledger, journal entry, account, or debit/credit -- that would duplicate ERPNext's source of
-- truth and inevitably drift from it. Every table here is one of three kinds:
--   1. invoice_cache / payment_cache / fee_schedule_cache: denormalized read-models of already
--      submitted ERPNext documents, refreshed by a sync process. Amount/status/date columns mirror
--      fields ERPNext itself already computed (never derived locally from ledger entries); the full
--      ERPNext document is additionally cached as JSONB (a genuinely external, evolving payload we
--      do not own -- see docs/database/migration-policy.md's normalization standard) so a cached
--      field this migration did not anticipate is still available without a schema change.
--   2. erpnext_id_mappings: the durable Studafy<->ERPNext identity crosswalk. It outlives any one
--      cache row (a cache table can be truncated and rebuilt from ERPNext without losing identity
--      continuity) and can exist before the ERPNext document does (erpnext_docname starts NULL,
--      reserved at outbox-enqueue time and filled in once ERPNext confirms creation).
--   3. finance_sync_outbox: a classic transactional outbox. When a Studafy-side event (e.g. a
--      captured online payment) must eventually be written into ERPNext, the same transaction that
--      records the local fact also inserts an outbox row, so a worker can reliably relay it without
--      a dual-write race. It carries no ledger meaning of its own -- only a command payload and its
--      delivery state.
--
-- Depends on 000008 (app.students) for the tenant-scoped student a cached invoice/payment belongs
-- to, and on 000009 (app.academic_years, app.terms) for a fee schedule's optional term scope.
--
-- studafy_id (on erpnext_id_mappings and finance_sync_outbox) is deliberately not a foreign key: it
-- is a crosswalk column that spans three distinct local identity spaces, one per
-- app.finance_entity_type value (invoice_cache.id, payment_cache.id, fee_schedule_cache.id), and
-- for outbound sync it may reference a business object that has no cache row yet. A single physical
-- column cannot carry three different foreign keys, and a CASE-dispatched trigger checking
-- existence per entity would still not close a real gap: a stale or momentarily orphaned crosswalk
-- row is harmless (the next sync corrects it), and application code must always resolve identity
-- through this table rather than assume a row exists. See docs/database/finance-data-model.md.

SET ROLE studafy_admin;

CREATE TYPE app.finance_entity_type AS ENUM ('invoice', 'payment', 'fee_schedule');
CREATE TYPE app.finance_sync_outbox_status AS ENUM ('pending', 'processing', 'completed', 'failed');

-- Read-model of one submitted ERPNext Sales Invoice. total_amount_minor/outstanding_amount_minor
-- mirror ERPNext's own computed fields; this table never derives them from ledger entries because
-- no ledger entries exist here.
CREATE TABLE app.invoice_cache (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_invoice_cache PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  erpnext_docname text NOT NULL,
  erpnext_status text NOT NULL,
  total_amount_minor bigint NOT NULL,
  outstanding_amount_minor bigint NOT NULL,
  issued_date date NOT NULL,
  due_date date,
  erpnext_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_invoice_cache_school_erpnext_docname UNIQUE (school_id, erpnext_docname),
  CONSTRAINT fk_invoice_cache_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_cache_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_cache_currency FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_invoice_cache_erpnext_docname CHECK (
    erpnext_docname = btrim(erpnext_docname) AND erpnext_docname <> ''
  ),
  CONSTRAINT ck_invoice_cache_erpnext_status CHECK (
    erpnext_status = btrim(erpnext_status) AND erpnext_status <> ''
  ),
  CONSTRAINT ck_invoice_cache_amounts CHECK (
    total_amount_minor >= 0
    AND outstanding_amount_minor >= 0
    AND outstanding_amount_minor <= total_amount_minor
  ),
  CONSTRAINT ck_invoice_cache_dates CHECK (due_date IS NULL OR due_date >= issued_date),
  CONSTRAINT ck_invoice_cache_timestamps CHECK (updated_at >= created_at)
);

-- Read-model of one submitted ERPNext Payment Entry. Deliberately flat: ERPNext payments can
-- allocate across multiple invoices (or none yet), and reconstructing that allocation locally would
-- be exactly the local ledger this migration must not build. amount_minor is the payment's own
-- total; which invoice(s) it settles remains a question answered by ERPNext, not this cache.
CREATE TABLE app.payment_cache (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_payment_cache PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  erpnext_docname text NOT NULL,
  erpnext_status text NOT NULL,
  amount_minor bigint NOT NULL,
  payment_date date NOT NULL,
  erpnext_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_payment_cache_school_erpnext_docname UNIQUE (school_id, erpnext_docname),
  CONSTRAINT fk_payment_cache_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_payment_cache_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_payment_cache_currency FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_payment_cache_erpnext_docname CHECK (
    erpnext_docname = btrim(erpnext_docname) AND erpnext_docname <> ''
  ),
  CONSTRAINT ck_payment_cache_erpnext_status CHECK (
    erpnext_status = btrim(erpnext_status) AND erpnext_status <> ''
  ),
  CONSTRAINT ck_payment_cache_amount CHECK (amount_minor >= 0),
  CONSTRAINT ck_payment_cache_timestamps CHECK (updated_at >= created_at)
);

-- Read-model of one ERPNext Fee Schedule. Unlike invoice/payment, a fee schedule is a template
-- applied to a group of students, not a single student's document, so it has no student_id. The
-- term/year link is optional and nullable: whether every fee schedule maps to exactly one term is
-- an ERPNext-side modeling detail this migration does not assume.
CREATE TABLE app.fee_schedule_cache (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_fee_schedule_cache PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid,
  term_id uuid,
  currency_id uuid NOT NULL,
  erpnext_docname text NOT NULL,
  erpnext_status text NOT NULL,
  title text NOT NULL,
  total_amount_minor bigint NOT NULL,
  erpnext_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_fee_schedule_cache_school_erpnext_docname UNIQUE (school_id, erpnext_docname),
  CONSTRAINT fk_fee_schedule_cache_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_fee_schedule_cache_academic_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_fee_schedule_cache_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_fee_schedule_cache_currency FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_fee_schedule_cache_term_requires_year CHECK (
    term_id IS NULL OR academic_year_id IS NOT NULL
  ),
  CONSTRAINT ck_fee_schedule_cache_erpnext_docname CHECK (
    erpnext_docname = btrim(erpnext_docname) AND erpnext_docname <> ''
  ),
  CONSTRAINT ck_fee_schedule_cache_erpnext_status CHECK (
    erpnext_status = btrim(erpnext_status) AND erpnext_status <> ''
  ),
  CONSTRAINT ck_fee_schedule_cache_title CHECK (title = btrim(title) AND title <> ''),
  CONSTRAINT ck_fee_schedule_cache_amount CHECK (total_amount_minor >= 0),
  CONSTRAINT ck_fee_schedule_cache_timestamps CHECK (updated_at >= created_at)
);

-- The durable Studafy<->ERPNext identity crosswalk, shared across every synced finance entity kind.
-- erpnext_docname is nullable because a mapping row can be reserved (studafy_id assigned) before
-- ERPNext has confirmed creation and returned its docname; once known, it never changes for a given
-- (school_id, entity, studafy_id) and is unique per (school_id, entity, erpnext_docname).
CREATE TABLE app.erpnext_id_mappings (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_erpnext_id_mappings PRIMARY KEY,
  school_id uuid NOT NULL,
  entity app.finance_entity_type NOT NULL,
  studafy_id uuid NOT NULL,
  erpnext_docname text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_erpnext_id_mappings_school_entity_studafy_id UNIQUE (school_id, entity, studafy_id),
  CONSTRAINT uq_erpnext_id_mappings_school_entity_docname UNIQUE (school_id, entity, erpnext_docname),
  CONSTRAINT fk_erpnext_id_mappings_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_erpnext_id_mappings_docname CHECK (
    erpnext_docname IS NULL OR (erpnext_docname = btrim(erpnext_docname) AND erpnext_docname <> '')
  ),
  CONSTRAINT ck_erpnext_id_mappings_timestamps CHECK (updated_at >= created_at)
);

-- Transactional outbox for Studafy -> ERPNext commands (e.g. relaying an online payment capture
-- into ERPNext, which alone may write the ledger). id is a plain ordered bigint identity, not a
-- uuid, because processing order -- not cross-table identity -- is this table's load-bearing
-- property; nothing else references outbox rows by id. This mirrors public.schema_migrations'
-- own ordered bigint version documented in docs/database/migration-policy.md.
CREATE TABLE app.finance_sync_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_finance_sync_outbox PRIMARY KEY,
  school_id uuid NOT NULL,
  entity app.finance_entity_type NOT NULL,
  studafy_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status app.finance_sync_outbox_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_finance_sync_outbox_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_finance_sync_outbox_attempts CHECK (attempts >= 0),
  CONSTRAINT ck_finance_sync_outbox_processed_state CHECK (
    (status IN ('completed', 'failed')) = (processed_at IS NOT NULL)
  ),
  CONSTRAINT ck_finance_sync_outbox_failed_has_error CHECK (
    status <> 'failed' OR (last_error IS NOT NULL AND btrim(last_error) <> '')
  ),
  CONSTRAINT ck_finance_sync_outbox_timestamps CHECK (updated_at >= created_at)
);

-- Deliberate indexes only. Primary/unique constraints already cover tenant-scoped docname lookup
-- and the id-mapping's two crosswalk directions.
CREATE INDEX idx_invoice_cache_school_student_id ON app.invoice_cache (school_id, student_id);
CREATE INDEX idx_invoice_cache_school_currency_id ON app.invoice_cache (school_id, currency_id);
CREATE INDEX idx_invoice_cache_school_due_date
  ON app.invoice_cache (school_id, due_date) WHERE due_date IS NOT NULL;

CREATE INDEX idx_payment_cache_school_student_id ON app.payment_cache (school_id, student_id);
CREATE INDEX idx_payment_cache_school_currency_id ON app.payment_cache (school_id, currency_id);
CREATE INDEX idx_payment_cache_school_payment_date
  ON app.payment_cache (school_id, payment_date);

CREATE INDEX idx_fee_schedule_cache_school_academic_year_id
  ON app.fee_schedule_cache (school_id, academic_year_id);
CREATE INDEX idx_fee_schedule_cache_school_term_id
  ON app.fee_schedule_cache (school_id, term_id);
CREATE INDEX idx_fee_schedule_cache_school_currency_id
  ON app.fee_schedule_cache (school_id, currency_id);

-- Backs the outbox worker's own polling query: the next eligible rows for one tenant.
CREATE INDEX idx_finance_sync_outbox_school_status_available
  ON app.finance_sync_outbox (school_id, status, available_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX idx_finance_sync_outbox_school_entity_studafy_id
  ON app.finance_sync_outbox (school_id, entity, studafy_id);

REVOKE ALL PRIVILEGES ON TABLE
  app.invoice_cache,
  app.payment_cache,
  app.fee_schedule_cache,
  app.erpnext_id_mappings,
  app.finance_sync_outbox
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.invoice_cache,
  app.payment_cache,
  app.fee_schedule_cache,
  app.erpnext_id_mappings,
  app.finance_sync_outbox
TO studafy_app;

REVOKE ALL ON TYPE app.finance_entity_type, app.finance_sync_outbox_status FROM PUBLIC;
GRANT USAGE ON TYPE app.finance_entity_type, app.finance_sync_outbox_status TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'invoice_cache');
SELECT app.apply_tenant_isolation('app', 'payment_cache');
SELECT app.apply_tenant_isolation('app', 'fee_schedule_cache');
SELECT app.apply_tenant_isolation('app', 'erpnext_id_mappings');
SELECT app.apply_tenant_isolation('app', 'finance_sync_outbox');

RESET ROLE;
