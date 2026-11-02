-- The students a fee structure is for.
--
-- A fee structure is an ERPNext document (projected into app.fee_structure_cache, 000062) and ERPNext
-- has no notion of "this structure is for these students": a Program groups a grade, not a person.
-- Schools also charge individual students their own structure (a late joiner, a special program), so
-- Studafy keeps that list itself. It is a default for billing, not a constraint: generating invoices
-- for the structure preselects these students, and finance can still bill anyone. No rows means the
-- structure is not tied to particular students.

SET ROLE studafy_admin;

CREATE TABLE app.fee_structure_students (
  school_id uuid NOT NULL,
  fee_structure_erpnext_name text NOT NULL,
  student_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_fee_structure_students
    PRIMARY KEY (school_id, fee_structure_erpnext_name, student_id),
  CONSTRAINT fk_fee_structure_students_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_fee_structure_students_structure
    FOREIGN KEY (school_id, fee_structure_erpnext_name)
    REFERENCES app.fee_structure_cache (school_id, erpnext_docname)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_fee_structure_students_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_fee_structure_students_student_fk
  ON app.fee_structure_students (student_id, school_id);

REVOKE ALL PRIVILEGES ON TABLE app.fee_structure_students FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, DELETE ON TABLE app.fee_structure_students TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'fee_structure_students');

RESET ROLE;
