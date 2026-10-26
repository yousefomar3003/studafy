-- Scholarships: a school-defined reduction of a student's fees, approved by the school admin.
--
-- The earlier ERPNext-projected design (000066 scholarship_discount_cache / award_cache) depended on
-- custom ERPNext doctypes and gave a school no way to define a scholarship; its tables are left in
-- place, unread. Studafy now owns both halves:
--
--   * app.scholarships        -- the school's catalog: "Sibling discount, 10%", "Merit, 200 JOD off
--                                tuition". Either a percentage or a fixed amount, applied to every
--                                fee or to one fee category.
--   * app.scholarship_awards  -- one scholarship granted to one student. Finance requests it
--                                (pending_approval); the school admin approves or rejects it, and can
--                                later revoke an approved award.
--
-- Only approved awards of active scholarships discount an invoice; the billing worker turns them
-- into the Sales Invoice's own discount when it generates the invoice, so ERPNext's totals, ledgers
-- and outstanding amounts stay authoritative. Invoices already issued are never changed.

SET ROLE studafy_admin;

CREATE TABLE app.scholarships (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_scholarships PRIMARY KEY,
  school_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  discount_type text NOT NULL,
  -- percentage: 0 < percentage <= 100. fixed: amount_minor in currency_id's minor units.
  percentage numeric(5, 2),
  amount_minor bigint,
  currency_id uuid,
  -- NULL applies to every fee; otherwise only to invoice lines of this fee category.
  fee_category text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_scholarships_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_scholarships_school_name UNIQUE (school_id, name),
  CONSTRAINT fk_scholarships_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_scholarships_currency FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_scholarships_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_scholarships_discount_type CHECK (discount_type IN ('percentage', 'fixed')),
  CONSTRAINT ck_scholarships_value CHECK (
    (discount_type = 'percentage'
      AND percentage > 0 AND percentage <= 100
      AND amount_minor IS NULL AND currency_id IS NULL)
    OR (discount_type = 'fixed'
      AND amount_minor > 0 AND currency_id IS NOT NULL
      AND percentage IS NULL)
  ),
  CONSTRAINT ck_scholarships_fee_category CHECK (
    fee_category IS NULL OR (fee_category = btrim(fee_category) AND fee_category <> '')
  ),
  CONSTRAINT ck_scholarships_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.scholarship_awards (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_scholarship_awards PRIMARY KEY,
  school_id uuid NOT NULL,
  scholarship_id uuid NOT NULL,
  student_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval',
  notes text,
  requested_by uuid NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_notes text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_scholarship_awards_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_scholarship_awards_scholarship FOREIGN KEY (scholarship_id, school_id)
    REFERENCES app.scholarships (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_scholarship_awards_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_scholarship_awards_status CHECK (
    status IN ('pending_approval', 'approved', 'rejected', 'revoked')
  ),
  -- Every decision records who made it and when; a pending award has neither.
  CONSTRAINT ck_scholarship_awards_decision CHECK (
    (status = 'pending_approval') = (decided_by IS NULL AND decided_at IS NULL)
  ),
  CONSTRAINT ck_scholarship_awards_timestamps CHECK (updated_at >= created_at)
);

-- A student holds a given scholarship at most once at a time; a rejected or revoked award can be
-- requested again.
CREATE UNIQUE INDEX uq_scholarship_awards_open
  ON app.scholarship_awards (school_id, student_id, scholarship_id)
  WHERE status IN ('pending_approval', 'approved');

CREATE INDEX idx_scholarship_awards_school_status
  ON app.scholarship_awards (school_id, status, created_at DESC);
CREATE INDEX idx_scholarship_awards_scholarship_fk
  ON app.scholarship_awards (scholarship_id, school_id);
CREATE INDEX idx_scholarship_awards_student_fk
  ON app.scholarship_awards (student_id, school_id);
CREATE INDEX idx_scholarships_currency_fk ON app.scholarships (currency_id);

REVOKE ALL PRIVILEGES ON TABLE app.scholarships, app.scholarship_awards FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.scholarships, app.scholarship_awards TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'scholarships');
SELECT app.apply_tenant_isolation('app', 'scholarship_awards');

RESET ROLE;
