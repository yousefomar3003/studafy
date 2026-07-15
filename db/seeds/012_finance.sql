-- Seed finance cache tables: invoice_cache, payment_cache, fee_schedule_cache.
-- Depends on: 002 (school), 004 (students), 005 (academic year/terms).

SET LOCAL ROLE studafy_admin;

-- Fee schedule cache for Fall 2026 tuition
INSERT INTO app.fee_schedule_cache (school_id, academic_year_id, term_id, currency_id, erpnext_docname, erpnext_status, title, total_amount_minor, erpnext_payload, last_synced_at)
SELECT
  current_setting('app.school_id')::uuid,
  ay.id,
  NULL,
  c.id,
  'SCHED-FALL-2025-TUITION',
  'Draft',
  'Fall 2026 Tuition',
  15000000,
  '{"type": "Tuition", "breakdown": "Base tuition"}'::jsonb,
  '2026-07-01 00:00:00+00'::timestamptz
FROM app.academic_years ay
CROSS JOIN app.currencies c
WHERE ay.school_id = current_setting('app.school_id')::uuid AND ay.code = 'AY-2025-2026'
  AND c.code = 'USD'
ON CONFLICT DO NOTHING;

-- Invoice for Alice (student 001)
INSERT INTO app.invoice_cache (school_id, student_id, currency_id, erpnext_docname, erpnext_status, total_amount_minor, outstanding_amount_minor, issued_date, due_date, erpnext_payload, last_synced_at)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  c.id,
  'INV-2026-001',
  'Overdue',
  7500000,
  7500000,
  '2026-01-15'::date,
  '2026-02-15'::date,
  '{"items": [{"description": "Spring 2026 Tuition", "amount": 7500000}]}'::jsonb,
  '2026-07-01 00:00:00+00'::timestamptz
FROM app.students s
CROSS JOIN app.currencies c
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-001'
  AND c.code = 'USD'
ON CONFLICT DO NOTHING;

-- Invoice for Bob (student 002) - partially paid
INSERT INTO app.invoice_cache (school_id, student_id, currency_id, erpnext_docname, erpnext_status, total_amount_minor, outstanding_amount_minor, issued_date, due_date, erpnext_payload, last_synced_at)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  c.id,
  'INV-2026-002',
  'Partially Paid',
  7500000,
  3750000,
  '2026-01-15'::date,
  '2026-02-15'::date,
  '{"items": [{"description": "Spring 2026 Tuition", "amount": 7500000}]}'::jsonb,
  '2026-07-01 00:00:00+00'::timestamptz
FROM app.students s
CROSS JOIN app.currencies c
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-002'
  AND c.code = 'USD'
ON CONFLICT DO NOTHING;

-- Invoice for Carol (student 003) - paid
INSERT INTO app.invoice_cache (school_id, student_id, currency_id, erpnext_docname, erpnext_status, total_amount_minor, outstanding_amount_minor, issued_date, due_date, erpnext_payload, last_synced_at)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  c.id,
  'INV-2026-003',
  'Paid',
  7500000,
  0,
  '2026-01-15'::date,
  '2026-02-15'::date,
  '{"items": [{"description": "Spring 2026 Tuition", "amount": 7500000}]}'::jsonb,
  '2026-07-01 00:00:00+00'::timestamptz
FROM app.students s
CROSS JOIN app.currencies c
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-003'
  AND c.code = 'USD'
ON CONFLICT DO NOTHING;

-- Payment for Bob's invoice (partial)
INSERT INTO app.payment_cache (school_id, student_id, currency_id, erpnext_docname, erpnext_status, amount_minor, payment_date, erpnext_payload, last_synced_at)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  c.id,
  'PAY-2026-001',
  'Paid',
  3750000,
  '2026-01-20'::date,
  '{"method": "bank_transfer", "reference": "TXN-123456"}'::jsonb,
  '2026-07-01 00:00:00+00'::timestamptz
FROM app.students s
CROSS JOIN app.currencies c
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-002'
  AND c.code = 'USD'
ON CONFLICT DO NOTHING;

-- Payment for Carol's invoice (full)
INSERT INTO app.payment_cache (school_id, student_id, currency_id, erpnext_docname, erpnext_status, amount_minor, payment_date, erpnext_payload, last_synced_at)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  c.id,
  'PAY-2026-002',
  'Paid',
  7500000,
  '2026-01-18'::date,
  '{"method": "credit_card", "reference": "TXN-789012"}'::jsonb,
  '2026-07-01 00:00:00+00'::timestamptz
FROM app.students s
CROSS JOIN app.currencies c
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-003'
  AND c.code = 'USD'
ON CONFLICT DO NOTHING;
