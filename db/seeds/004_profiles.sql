-- Seed student profiles, teacher profiles, and parent-child links.
-- Depends on: 003 (users must exist).

SET LOCAL ROLE studafy_admin;

-- Teachers
INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status, hire_date)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'EMP-1001',
  'active',
  '2020-08-15'::date
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT (school_id, user_id) DO NOTHING;

INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status, hire_date)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'EMP-1002',
  'active',
  '2019-08-15'::date
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'teacher.science@demo-academy.local'
ON CONFLICT (school_id, user_id) DO NOTHING;

INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status, hire_date)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'EMP-1003',
  'active',
  '2021-01-10'::date
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'teacher.english@demo-academy.local'
ON CONFLICT (school_id, user_id) DO NOTHING;

INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status, hire_date)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'EMP-1004',
  'active',
  '2022-08-15'::date
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'ta.history@demo-academy.local'
ON CONFLICT (school_id, user_id) DO NOTHING;

-- Students
INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, date_of_birth, status, admission_date)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'ADM-2026-001',
  'Alice',
  'Johnson',
  '2010-03-15'::date,
  'enrolled',
  '2025-09-01'::date
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.alice@demo-academy.local'
ON CONFLICT (school_id, user_id) DO NOTHING;

INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, date_of_birth, status, admission_date)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'ADM-2026-002',
  'Bob',
  'Smith',
  '2010-07-22'::date,
  'enrolled',
  '2025-09-01'::date
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.bob@demo-academy.local'
ON CONFLICT (school_id, user_id) DO NOTHING;

INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, date_of_birth, status, admission_date)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'ADM-2026-003',
  'Carol',
  'Williams',
  '2010-11-08'::date,
  'enrolled',
  '2025-09-01'::date
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.carol@demo-academy.local'
ON CONFLICT (school_id, user_id) DO NOTHING;

INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, date_of_birth, status, admission_date)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'ADM-2026-004',
  'Dave',
  'Brown',
  '2011-01-30'::date,
  'enrolled',
  '2025-09-01'::date
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.dave@demo-academy.local'
ON CONFLICT (school_id, user_id) DO NOTHING;

INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, date_of_birth, status, admission_date)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'ADM-2026-005',
  'Eve',
  'Davis',
  '2010-05-18'::date,
  'enrolled',
  '2025-09-01'::date
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.eve@demo-academy.local'
ON CONFLICT (school_id, user_id) DO NOTHING;

-- Parent-child link: Frank Johnson is Alice's father
INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship)
SELECT
  current_setting('app.school_id')::uuid,
  parent.id,
  student.id,
  'father'::app.parent_relationship
FROM app.users parent
JOIN app.users student_user
  ON student_user.school_id = parent.school_id
  AND student_user.normalized_email = 'student.alice@demo-academy.local'
JOIN app.students student
  ON student.school_id = student_user.school_id
  AND student.user_id = student_user.id
WHERE parent.school_id = current_setting('app.school_id')::uuid
  AND parent.normalized_email = 'parent.frank@demo-academy.local'
ON CONFLICT (school_id, parent_user_id, student_id) DO NOTHING;
