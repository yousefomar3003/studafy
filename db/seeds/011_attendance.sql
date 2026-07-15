-- Seed attendance sessions and records for July 2026.
-- Timestamps fall within the existing 2026-07 partition.
-- Depends on: 006 (classes), 004 (students, teachers).

SET LOCAL ROLE studafy_admin;

-- Session 1: MATH-101, July 7 2026
INSERT INTO app.attendance_sessions (school_id, class_id, session_date, period, status, taken_by_user_id, created_at, updated_at)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  '2026-07-07'::date,
  1,
  'submitted',
  u.id,
  '2026-07-07 09:00:00+00'::timestamptz(3),
  '2026-07-07 09:05:00+00'::timestamptz(3)
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-MATH-101-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT DO NOTHING;

-- Records for Session 1 (all 5 students enrolled in MATH)
INSERT INTO app.attendance_records (school_id, attendance_session_id, session_created_at, student_id, status, recorded_by_user_id, created_at, updated_at)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  s.created_at,
  st.id,
  'present',
  u.id,
  '2026-07-07 09:01:00+00'::timestamptz(3),
  '2026-07-07 09:01:00+00'::timestamptz(3)
FROM app.attendance_sessions s
CROSS JOIN app.students st
CROSS JOIN app.users u
WHERE s.school_id = current_setting('app.school_id')::uuid
  AND s.session_date = '2026-07-07'::date
  AND s.class_id = (SELECT id FROM app.classes WHERE school_id = current_setting('app.school_id')::uuid AND code = 'CLASS-MATH-101-SP26')
  AND st.school_id = current_setting('app.school_id')::uuid AND st.admission_number = 'ADM-2026-001'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT DO NOTHING;

INSERT INTO app.attendance_records (school_id, attendance_session_id, session_created_at, student_id, status, recorded_by_user_id, created_at, updated_at)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  s.created_at,
  st.id,
  'present',
  u.id,
  '2026-07-07 09:01:00+00'::timestamptz(3),
  '2026-07-07 09:01:00+00'::timestamptz(3)
FROM app.attendance_sessions s
CROSS JOIN app.students st
CROSS JOIN app.users u
WHERE s.school_id = current_setting('app.school_id')::uuid
  AND s.session_date = '2026-07-07'::date
  AND s.class_id = (SELECT id FROM app.classes WHERE school_id = current_setting('app.school_id')::uuid AND code = 'CLASS-MATH-101-SP26')
  AND st.school_id = current_setting('app.school_id')::uuid AND st.admission_number = 'ADM-2026-002'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT DO NOTHING;

INSERT INTO app.attendance_records (school_id, attendance_session_id, session_created_at, student_id, status, minutes_late, recorded_by_user_id, created_at, updated_at)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  s.created_at,
  st.id,
  'late',
  15,
  u.id,
  '2026-07-07 09:01:00+00'::timestamptz(3),
  '2026-07-07 09:01:00+00'::timestamptz(3)
FROM app.attendance_sessions s
CROSS JOIN app.students st
CROSS JOIN app.users u
WHERE s.school_id = current_setting('app.school_id')::uuid
  AND s.session_date = '2026-07-07'::date
  AND s.class_id = (SELECT id FROM app.classes WHERE school_id = current_setting('app.school_id')::uuid AND code = 'CLASS-MATH-101-SP26')
  AND st.school_id = current_setting('app.school_id')::uuid AND st.admission_number = 'ADM-2026-003'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT DO NOTHING;

INSERT INTO app.attendance_records (school_id, attendance_session_id, session_created_at, student_id, status, recorded_by_user_id, created_at, updated_at)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  s.created_at,
  st.id,
  'absent',
  u.id,
  '2026-07-07 09:01:00+00'::timestamptz(3),
  '2026-07-07 09:01:00+00'::timestamptz(3)
FROM app.attendance_sessions s
CROSS JOIN app.students st
CROSS JOIN app.users u
WHERE s.school_id = current_setting('app.school_id')::uuid
  AND s.session_date = '2026-07-07'::date
  AND s.class_id = (SELECT id FROM app.classes WHERE school_id = current_setting('app.school_id')::uuid AND code = 'CLASS-MATH-101-SP26')
  AND st.school_id = current_setting('app.school_id')::uuid AND st.admission_number = 'ADM-2026-004'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT DO NOTHING;

INSERT INTO app.attendance_records (school_id, attendance_session_id, session_created_at, student_id, status, recorded_by_user_id, created_at, updated_at)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  s.created_at,
  st.id,
  'present',
  u.id,
  '2026-07-07 09:01:00+00'::timestamptz(3),
  '2026-07-07 09:01:00+00'::timestamptz(3)
FROM app.attendance_sessions s
CROSS JOIN app.students st
CROSS JOIN app.users u
WHERE s.school_id = current_setting('app.school_id')::uuid
  AND s.session_date = '2026-07-07'::date
  AND s.class_id = (SELECT id FROM app.classes WHERE school_id = current_setting('app.school_id')::uuid AND code = 'CLASS-MATH-101-SP26')
  AND st.school_id = current_setting('app.school_id')::uuid AND st.admission_number = 'ADM-2026-005'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT DO NOTHING;

-- Session 2: MATH-101, July 9 2026
INSERT INTO app.attendance_sessions (school_id, class_id, session_date, period, status, taken_by_user_id, created_at, updated_at)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  '2026-07-09'::date,
  1,
  'submitted',
  u.id,
  '2026-07-09 09:00:00+00'::timestamptz(3),
  '2026-07-09 09:05:00+00'::timestamptz(3)
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-MATH-101-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT DO NOTHING;

-- Session 3: SCI-201, July 10 2026
INSERT INTO app.attendance_sessions (school_id, class_id, session_date, period, status, taken_by_user_id, created_at, updated_at)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  '2026-07-10'::date,
  2,
  'open',
  u.id,
  '2026-07-10 10:00:00+00'::timestamptz(3),
  '2026-07-10 10:00:00+00'::timestamptz(3)
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-SCI-201-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.science@demo-academy.local'
ON CONFLICT DO NOTHING;
