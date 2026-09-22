-- integrity check: enrollment-invoice-consistency
--
-- The finance read-models (invoice_cache / payment_cache, migration 000015) denormalize ERPNext
-- documents onto app.students per school. They carry no link to app.enrollments at all -- the only
-- consistency invariant available is that a student the school has invoiced (or recorded a payment
-- against) actually has at least one enrollment in the school. The reverse direction is NOT an
-- invariant: a school legitimately has enrolled students who have not been invoiced yet (the demo
-- seed bills only 4 of its 8 students), so "enrolled but un-invoiced" is never a finding.
--
-- Three findings classes, all scoped to this school:
--   1. invoice  -> no enrollment: an invoice_cache student with zero enrollments.
--   2. payment  -> no enrollment: a payment_cache student with zero enrollments.
--   3. payment  -> no invoice:    a payment_cache student with zero invoice_cache rows (ERPNext
--                                  Payment Entry allocation is itself cross-checked against Sales
--                                  Invoices on the ERPNext side, so a payment with no local invoice
--                                  at all mirrors broken remote state; drill-corruption.sh relies on
--                                  1+2 by deleting an invoice's student's only enrollment).
-- Enrollment rows count regardless of status (active, waitlisted, withdrawn, ...): the invariant is
-- "this student has or had a relationship with the school", not "currently attending".
--
-- One JSON line on stdout. Run via:
--   psql -X -tA -v ON_ERROR_STOP=1 -v school_id=<uuid> -f 02-enrollment-invoice-consistency.sql
-- The first statement prints set_config's return value; consume only the last output line.

SELECT set_config('app.school_id', :'school_id', false);

CREATE TEMP TABLE findings (
  issue       text NOT NULL,
  entity      text NOT NULL,
  student_id  text NOT NULL,
  admission   text,
  docname     text NOT NULL,
  detail      text NOT NULL
);

INSERT INTO findings (issue, entity, student_id, admission, docname, detail)
SELECT 'no-enrollment'                    AS issue,
       'invoice'                           AS entity,
       i.student_id::text                  AS student_id,
       s.admission_number                  AS admission,
       i.erpnext_docname                   AS docname,
       format('invoice %s exists for student %s (%s) but the student has no enrollment in this school',
         i.erpnext_docname, s.first_name || ' ' || s.last_name, s.admission_number) AS detail
FROM app.invoice_cache AS i
JOIN app.students AS s ON s.id = i.student_id AND s.school_id = i.school_id
WHERE i.school_id = current_setting('app.school_id')::uuid
  AND NOT EXISTS (
    SELECT 1
    FROM app.enrollments AS e
    WHERE e.school_id = i.school_id
      AND e.student_id = i.student_id
  );

INSERT INTO findings (issue, entity, student_id, admission, docname, detail)
SELECT 'no-enrollment'                AS issue,
       'payment'                       AS entity,
       p.student_id::text              AS student_id,
       s.admission_number              AS admission,
       p.erpnext_docname               AS docname,
       format('payment %s recorded for student %s (%s) but the student has no enrollment in this school',
         p.erpnext_docname, s.first_name || ' ' || s.last_name, s.admission_number) AS detail
FROM app.payment_cache AS p
JOIN app.students AS s ON s.id = p.student_id AND s.school_id = p.school_id
WHERE p.school_id = current_setting('app.school_id')::uuid
  AND NOT EXISTS (
    SELECT 1
    FROM app.enrollments AS e
    WHERE e.school_id = p.school_id
      AND e.student_id = p.student_id
  );

INSERT INTO findings (issue, entity, student_id, admission, docname, detail)
SELECT 'no-invoice'                   AS issue,
       'payment'                       AS entity,
       p.student_id::text              AS student_id,
       s.admission_number              AS admission,
       p.erpnext_docname               AS docname,
       format('payment %s recorded for student %s (%s) but the student has no invoice in this school',
         p.erpnext_docname, s.first_name || ' ' || s.last_name, s.admission_number) AS detail
FROM app.payment_cache AS p
JOIN app.students AS s ON s.id = p.student_id AND s.school_id = p.school_id
WHERE p.school_id = current_setting('app.school_id')::uuid
  AND NOT EXISTS (
    SELECT 1
    FROM app.invoice_cache AS i
    WHERE i.school_id = p.school_id
      AND i.student_id = p.student_id
  );

SELECT json_build_object(
  'check', 'enrollment-invoice-consistency',
  'status', CASE WHEN (SELECT count(*) FROM findings) = 0 THEN 'pass' ELSE 'fail' END,
  'findings_count', (SELECT count(*) FROM findings),
  'findings', COALESCE((
    SELECT json_agg(json_build_object(
      'issue', issue,
      'entity', entity,
      'student_id', student_id,
      'admission_number', admission,
      'erpnext_docname', docname,
      'detail', detail
    ) ORDER BY entity, student_id, docname)
    FROM (SELECT * FROM findings ORDER BY entity, student_id LIMIT 100) f
  ), '[]'::json),
  'summary', (SELECT
    CASE WHEN (SELECT count(*) FROM findings) = 0
      THEN 'every invoiced and every paid student has at least one enrollment; every paid student has an invoice'
      ELSE (SELECT
        'found ' || count(*) || ' inconsistency(ies): ' ||
        count(*) FILTER (WHERE issue = 'no-enrollment' AND entity = 'invoice') || ' invoiced student(s) without enrollment, ' ||
        count(*) FILTER (WHERE issue = 'no-enrollment' AND entity = 'payment') || ' paid student(s) without enrollment, ' ||
        count(*) FILTER (WHERE issue = 'no-invoice') || ' paid student(s) without invoice'
        FROM findings)
    END
  )
);