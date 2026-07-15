-- Seed an approved timetable version with weekly slots for Spring 2026.
-- Depends on: 006 (classes), 004 (teachers), 005 (rooms).
-- The timetable version starts as draft, is submitted, then approved via the state machine trigger.

SET LOCAL ROLE studafy_admin;

-- Timetable version (starts as draft via INSERT, then transitions to approved)
INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name, status)
SELECT
  current_setting('app.school_id')::uuid,
  ay.id,
  t.id,
  'Spring 2026 Official',
  'draft'
FROM app.academic_years ay
CROSS JOIN app.terms t
WHERE ay.school_id = current_setting('app.school_id')::uuid AND ay.code = 'AY-2025-2026'
  AND t.school_id = current_setting('app.school_id')::uuid AND t.code = 'SPRING-2026'
ON CONFLICT (school_id, term_id, name) DO NOTHING;

-- Submit the timetable (draft -> pending)
UPDATE app.timetable_versions
SET status = 'pending',
    submitted_by_user_id = (
      SELECT id FROM app.users
      WHERE school_id = current_setting('app.school_id')::uuid
        AND normalized_email = 'principal@demo-academy.local'
    )
WHERE school_id = current_setting('app.school_id')::uuid
  AND name = 'Spring 2026 Official'
  AND status = 'draft';

-- Approve the timetable (pending -> approved)
UPDATE app.timetable_versions
SET status = 'approved',
    approved_by_user_id = (
      SELECT id FROM app.users
      WHERE school_id = current_setting('app.school_id')::uuid
        AND normalized_email = 'principal@demo-academy.local'
    )
WHERE school_id = current_setting('app.school_id')::uuid
  AND name = 'Spring 2026 Official'
  AND status = 'pending';

-- Weekly timetable slots (15 slots across Mon-Fri, 3 periods each)
-- Uses subqueries to resolve class, teacher, and room IDs by natural keys.
-- Monday
INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  1, 1
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-MATH-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1001'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-101'
ON CONFLICT DO NOTHING;

INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  1, 2
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-SCI-201-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1002'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-201'
ON CONFLICT DO NOTHING;

INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  1, 3
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-ENG-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1003'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-301'
ON CONFLICT DO NOTHING;

-- Tuesday
INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  2, 1
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-HIST-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1004'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-101'
ON CONFLICT DO NOTHING;

INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  2, 2
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-ART-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1001'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-401'
ON CONFLICT DO NOTHING;

INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  2, 3
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-MATH-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1001'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-101'
ON CONFLICT DO NOTHING;

-- Wednesday
INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  3, 1
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-SCI-201-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1002'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-201'
ON CONFLICT DO NOTHING;

INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  3, 2
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-ENG-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1003'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-301'
ON CONFLICT DO NOTHING;

INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  3, 3
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-MATH-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1001'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-101'
ON CONFLICT DO NOTHING;

-- Thursday
INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  4, 1
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-MATH-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1001'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-101'
ON CONFLICT DO NOTHING;

INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  4, 2
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-SCI-201-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1002'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-201'
ON CONFLICT DO NOTHING;

INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  4, 3
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-HIST-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1004'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-101'
ON CONFLICT DO NOTHING;

-- Friday
INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  5, 1
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-ENG-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1003'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-301'
ON CONFLICT DO NOTHING;

INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  5, 2
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-ART-101-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1001'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-401'
ON CONFLICT DO NOTHING;

INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
SELECT
  current_setting('app.school_id')::uuid,
  tv.id,
  cl.id,
  te.id,
  r.id,
  5, 3
FROM app.timetable_versions tv
CROSS JOIN app.classes cl
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE tv.school_id = current_setting('app.school_id')::uuid AND tv.name = 'Spring 2026 Official'
  AND cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-SCI-201-SP26'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1002'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-201'
ON CONFLICT DO NOTHING;
