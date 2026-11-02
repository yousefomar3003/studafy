-- Batch invoice generation (ST-202). Tracks a "generate invoices for these students" run with
-- per-student progress, the same shape 000045 already uses for bulk invitation dispatch: a batch
-- header row with running counts, one item row per target student, and a queue worker that updates
-- items as it works so the run is resumable (a retried job only touches items still `pending`) and
-- pollable (a client reads the header for the summary meter and pages the items for per-row status)
-- without either side re-deriving progress from ERPNext itself.
--
-- Depends on 000015 (app.invoice_cache, whose rows this run eventually produces), 000008
-- (app.students, the target of a batch), and 000009 (app.classes, for target_class_ids' junction
-- table below).

SET ROLE studafy_admin;

CREATE TYPE app.invoice_batch_status AS ENUM (
  'pending', 'processing', 'completed', 'failed'
);

CREATE TYPE app.invoice_batch_item_status AS ENUM (
  'pending', 'succeeded', 'already_existed', 'failed'
);

-- One row per "generate invoices for this fee structure/period, targeted at these students" run.
-- No target_class_ids column here: which classes a batch targets (empty = "every student in the
-- school") is a many-to-many fact, normalized into app.invoice_batch_target_classes below rather
-- than an array column, per this repo's own normalization standard (docs/database/migration-policy.md
-- — "use junction tables for many-to-many relationships"; JSONB/arrays are for genuinely flexible or
-- external payloads, which a fixed set of Studafy class ids is not). Targeting is fixed once the
-- batch is created, not re-evaluated as enrollment changes while the run is in flight.
CREATE TABLE app.invoice_batches (
  id                          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id                   uuid NOT NULL,
  created_by                  uuid NOT NULL,
  status                      app.invoice_batch_status NOT NULL DEFAULT 'pending',
  fee_structure_erpnext_name  text NOT NULL,
  period_title                text NOT NULL,
  due_date                    date,
  total_count                 int NOT NULL DEFAULT 0,
  succeeded_count             int NOT NULL DEFAULT 0,
  already_existed_count       int NOT NULL DEFAULT 0,
  failed_count                int NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at                timestamptz,

  CONSTRAINT uq_invoice_batches_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_invoice_batches_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id),
  CONSTRAINT fk_invoice_batches_user FOREIGN KEY (created_by, school_id)
    REFERENCES app.users (id, school_id),
  CONSTRAINT ck_invoice_batches_fee_structure CHECK (
    fee_structure_erpnext_name = btrim(fee_structure_erpnext_name)
    AND fee_structure_erpnext_name <> ''
  ),
  CONSTRAINT ck_invoice_batches_period_title CHECK (
    period_title = btrim(period_title) AND period_title <> ''
  ),
  CONSTRAINT ck_invoice_batches_counts CHECK (
    total_count >= 0 AND succeeded_count >= 0 AND already_existed_count >= 0 AND failed_count >= 0
    AND succeeded_count + already_existed_count + failed_count <= total_count
  )
);

CREATE INDEX idx_invoice_batches_school_status
  ON app.invoice_batches (school_id, status, created_at DESC);

-- One row per (batch, targeted class). Absent for a batch that targets "every student" — read as
-- an empty set, not NULL, so a read query's aggregate (array_agg) naturally returns NULL/no rows
-- for that case without a separate sentinel.
CREATE TABLE app.invoice_batch_target_classes (
  batch_id   uuid NOT NULL,
  school_id  uuid NOT NULL,
  class_id   uuid NOT NULL,

  CONSTRAINT pk_invoice_batch_target_classes PRIMARY KEY (batch_id, class_id),
  CONSTRAINT fk_invoice_batch_target_classes_batch FOREIGN KEY (batch_id, school_id)
    REFERENCES app.invoice_batches (id, school_id) ON DELETE CASCADE,
  CONSTRAINT fk_invoice_batch_target_classes_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id),
  CONSTRAINT fk_invoice_batch_target_classes_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id)
);

-- RLS filters every query by school_id; the composite PK above leads with batch_id, not
-- school_id, so without this a tenant-scoped read of this table would seq-scan.
CREATE INDEX idx_invoice_batch_target_classes_school
  ON app.invoice_batch_target_classes (school_id, batch_id);

CREATE TABLE app.invoice_batch_items (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  batch_id        uuid NOT NULL,
  school_id       uuid NOT NULL,
  student_id      uuid NOT NULL,
  status          app.invoice_batch_item_status NOT NULL DEFAULT 'pending',
  erpnext_docname text,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_invoice_batch_items_batch FOREIGN KEY (batch_id, school_id)
    REFERENCES app.invoice_batches (id, school_id) ON DELETE CASCADE,
  CONSTRAINT fk_invoice_batch_items_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id),
  CONSTRAINT fk_invoice_batch_items_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id)
);

CREATE UNIQUE INDEX uq_invoice_batch_items_batch_student
  ON app.invoice_batch_items (batch_id, student_id);

CREATE INDEX idx_invoice_batch_items_batch_status
  ON app.invoice_batch_items (batch_id, status);

CREATE INDEX idx_invoice_batch_items_school
  ON app.invoice_batch_items (school_id, batch_id);

SELECT app.apply_tenant_isolation('app', 'invoice_batches');
SELECT app.apply_tenant_isolation('app', 'invoice_batch_target_classes');
SELECT app.apply_tenant_isolation('app', 'invoice_batch_items');

REVOKE ALL PRIVILEGES ON TABLE app.invoice_batches FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.invoice_batches TO studafy_app;

REVOKE ALL PRIVILEGES ON TABLE app.invoice_batch_target_classes FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE app.invoice_batch_target_classes TO studafy_app;

REVOKE ALL PRIVILEGES ON TABLE app.invoice_batch_items FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.invoice_batch_items TO studafy_app;

REVOKE ALL ON TYPE app.invoice_batch_status FROM PUBLIC;
GRANT USAGE ON TYPE app.invoice_batch_status TO studafy_app;

REVOKE ALL ON TYPE app.invoice_batch_item_status FROM PUBLIC;
GRANT USAGE ON TYPE app.invoice_batch_item_status TO studafy_app;

RESET ROLE;
