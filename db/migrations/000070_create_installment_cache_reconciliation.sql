-- ST-122: installment cache (per-installment read-model) and daily reconciliation audit log.
--
-- ERPNext owns fee schedules, installment balances, and AR/GL reconciliation. This table is a
-- projection for the student/parent installment breakdown view, refreshed by gateway writes and
-- the daily reconciliation job.
--
-- fee_structure_cache (000062) stores the *priced template*. This table stores the dated per-student
-- *applications* of those templates -- one row per installment per student per Fee Schedule.
--
-- Note: migration 000015 already created `app.fee_schedule_cache` as a per-Fee-Schedule template
-- cache (one row per template, no per-installment fields). This table is at a different grain:
-- one row per *installment* per student. They coexist with distinct names.
--
-- Depends on 000015 (app.finance_entity_type now includes 'fee_schedule'), 000062
-- (app.fee_structure_cache), 000004 (app.schools), 000008 (app.students), 000006
-- (app.apply_tenant_isolation).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- 1. installment_cache - per-installment read-model projection
-- ---------------------------------------------------------------------------

CREATE TABLE app.installment_cache (
  id                        uuid DEFAULT gen_random_uuid()
                              CONSTRAINT pk_installment_cache PRIMARY KEY,
  school_id                 uuid NOT NULL,
  erpnext_fee_schedule_id   text NOT NULL,
  student_id                uuid NOT NULL,
  fee_structure_id          uuid,
  due_date                  date NOT NULL,
  total_amount_minor        bigint NOT NULL,
  paid_amount_minor         bigint NOT NULL DEFAULT 0,
  outstanding_amount_minor  bigint NOT NULL,
  currency_id               uuid NOT NULL,
  status                    text NOT NULL DEFAULT 'pending',
  erpnext_payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at                 timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_installment_cache_school_schedule
    UNIQUE (school_id, erpnext_fee_schedule_id),

  CONSTRAINT fk_installment_cache_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_installment_cache_student
    FOREIGN KEY (student_id, school_id) REFERENCES app.students (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_installment_cache_fee_structure
    FOREIGN KEY (fee_structure_id) REFERENCES app.fee_structure_cache (id)
    ON UPDATE RESTRICT ON DELETE SET NULL,

  CONSTRAINT fk_installment_cache_currency
    FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_installment_cache_status CHECK (
    status IN ('pending', 'partially_paid', 'paid', 'overdue')
  ),

  CONSTRAINT ck_installment_cache_amounts CHECK (
    total_amount_minor >= 0
    AND paid_amount_minor  >= 0
    AND outstanding_amount_minor >= 0
    AND paid_amount_minor + outstanding_amount_minor <= total_amount_minor
  ),

  CONSTRAINT ck_installment_cache_timestamps CHECK (updated_at >= created_at)
);

COMMENT ON TABLE app.installment_cache IS
  'Per-installment read-model of ERPNext Fee Schedule entries. Refreshed by gateway writes and the daily reconciliation job.';

COMMENT ON COLUMN app.installment_cache.erpnext_fee_schedule_id IS
  'ERPNext Fee Schedule document name -- the stable external identity. 1:1 with the cache row per school.';

COMMENT ON COLUMN app.installment_cache.status IS
  'pending | partially_paid | paid | overdue. Computed from due_date and outstanding_amount_minor.';

-- 1:1 mapping constraint between tenant Fee Schedule and cache
CREATE UNIQUE INDEX idx_installment_cache_unique
  ON app.installment_cache (school_id, erpnext_fee_schedule_id);

-- Student installment lookup -- fastest path for the student/parent UI
CREATE INDEX idx_installment_cache_student
  ON app.installment_cache (school_id, student_id, due_date ASC);

-- Overdue and status monitoring -- partial index for the reconciliation job
CREATE INDEX idx_installment_cache_status
  ON app.installment_cache (school_id, status, due_date)
  WHERE status IN ('pending', 'partially_paid', 'overdue');

-- ---------------------------------------------------------------------------
-- 2. finance_reconciliation_logs -- daily AR/GL reconciliation audit
-- ---------------------------------------------------------------------------

CREATE TABLE app.finance_reconciliation_logs (
  id                        uuid DEFAULT gen_random_uuid()
                              CONSTRAINT pk_finance_reconciliation_logs PRIMARY KEY,
  school_id                 uuid NOT NULL,
  job_run_at                timestamptz NOT NULL,
  records_checked           integer NOT NULL DEFAULT 0,
  drift_detected_count      integer NOT NULL DEFAULT 0,
  auto_healed_count         integer NOT NULL DEFAULT 0,
  unresolved_divergences    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                    text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_reconciliation_logs_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_reconciliation_logs_status CHECK (
    status IN ('success', 'drift_corrected', 'alerted_divergence')
  )
);

COMMENT ON TABLE app.finance_reconciliation_logs IS
  'Audit trail for daily reconciliation runs. Logs records checked, drift detected, auto-healed items, and any unresolved divergences that required alerting.';

COMMENT ON COLUMN app.finance_reconciliation_logs.unresolved_divergences IS
  'JSON array of objects: { school_id, student_id, erpnext_fee_schedule_id, erpnext_outstanding, local_outstanding }. Populated only when status = alerted_divergence.';

-- Reconciliation log audit index -- for querying a school's reconciliation history
CREATE INDEX idx_reconciliation_logs_school
  ON app.finance_reconciliation_logs (school_id, job_run_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Grants and RLS
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.installment_cache FROM PUBLIC, studafy_app;
-- No DELETE: cache rows are superseded by re-sync, never removed by the application.
-- ERPNext decides when a schedule ceases to exist via its status/amounts.
GRANT SELECT, INSERT, UPDATE ON TABLE app.installment_cache TO studafy_app;

REVOKE ALL PRIVILEGES ON TABLE app.finance_reconciliation_logs FROM PUBLIC, studafy_app;
-- INSERT-only for the reconciliation job; SELECT for monitoring dashboards.
GRANT SELECT, INSERT ON TABLE app.finance_reconciliation_logs TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'installment_cache');
SELECT app.apply_tenant_isolation('app', 'finance_reconciliation_logs');

RESET ROLE;
