-- Seed classes and enrollments for the active Spring 2026 term.
-- Depends on: 004 (teachers, students), 005 (academic year, term, courses, rooms).

SET LOCAL ROLE studafy_admin;

-- Classes for Spring 2026
INSERT INTO app.classes (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity, status)
SELECT
  current_setting('app.school_id')::uuid,
  c.id,
  ay.id,
  t.id,
  te.id,
  r.id,
  'CLASS-MATH-101-SP26',
  40,
  'active'
FROM app.courses c
CROSS JOIN app.academic_years ay
CROSS JOIN app.terms t
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE c.school_id = current_setting('app.school_id')::uuid AND c.code = 'MATH-101'
  AND ay.school_id = current_setting('app.school_id')::uuid AND ay.code = 'AY-2025-2026'
  AND t.school_id = current_setting('app.school_id')::uuid AND t.code = 'SPRING-2026'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1001'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-101'
ON CONFLICT (school_id, code) DO NOTHING;

INSERT INTO app.classes (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity, status)
SELECT
  current_setting('app.school_id')::uuid,
  c.id,
  ay.id,
  t.id,
  te.id,
  r.id,
  'CLASS-SCI-201-SP26',
  30,
  'active'
FROM app.courses c
CROSS JOIN app.academic_years ay
CROSS JOIN app.terms t
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE c.school_id = current_setting('app.school_id')::uuid AND c.code = 'SCI-201'
  AND ay.school_id = current_setting('app.school_id')::uuid AND ay.code = 'AY-2025-2026'
  AND t.school_id = current_setting('app.school_id')::uuid AND t.code = 'SPRING-2026'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1002'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-201'
ON CONFLICT (school_id, code) DO NOTHING;

INSERT INTO app.classes (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity, status)
SELECT
  current_setting('app.school_id')::uuid,
  c.id,
  ay.id,
  t.id,
  te.id,
  r.id,
  'CLASS-ENG-101-SP26',
  35,
  'active'
FROM app.courses c
CROSS JOIN app.academic_years ay
CROSS JOIN app.terms t
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE c.school_id = current_setting('app.school_id')::uuid AND c.code = 'ENG-101'
  AND ay.school_id = current_setting('app.school_id')::uuid AND ay.code = 'AY-2025-2026'
  AND t.school_id = current_setting('app.school_id')::uuid AND t.code = 'SPRING-2026'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1003'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-301'
ON CONFLICT (school_id, code) DO NOTHING;

INSERT INTO app.classes (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity, status)
SELECT
  current_setting('app.school_id')::uuid,
  c.id,
  ay.id,
  t.id,
  te.id,
  r.id,
  'CLASS-HIST-101-SP26',
  35,
  'active'
FROM app.courses c
CROSS JOIN app.academic_years ay
CROSS JOIN app.terms t
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE c.school_id = current_setting('app.school_id')::uuid AND c.code = 'HIST-101'
  AND ay.school_id = current_setting('app.school_id')::uuid AND ay.code = 'AY-2025-2026'
  AND t.school_id = current_setting('app.school_id')::uuid AND t.code = 'SPRING-2026'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1004'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-101'
ON CONFLICT (school_id, code) DO NOTHING;

INSERT INTO app.classes (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity, status)
SELECT
  current_setting('app.school_id')::uuid,
  c.id,
  ay.id,
  t.id,
  te.id,
  r.id,
  'CLASS-ART-101-SP26',
  25,
  'active'
FROM app.courses c
CROSS JOIN app.academic_years ay
CROSS JOIN app.terms t
CROSS JOIN app.teachers te
CROSS JOIN app.rooms r
WHERE c.school_id = current_setting('app.school_id')::uuid AND c.code = 'ART-101'
  AND ay.school_id = current_setting('app.school_id')::uuid AND ay.code = 'AY-2025-2026'
  AND t.school_id = current_setting('app.school_id')::uuid AND t.code = 'SPRING-2026'
  AND te.school_id = current_setting('app.school_id')::uuid AND te.employee_number = 'EMP-1001'
  AND r.school_id = current_setting('app.school_id')::uuid AND r.code = 'ROOM-401'
ON CONFLICT (school_id, code) DO NOTHING;

-- Enrollments: all 5 students in MATH, SCI, ENG
INSERT INTO app.enrollments (school_id, class_id, student_id, status)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  st.id,
  'active'
FROM app.classes cl
CROSS JOIN app.students st
WHERE cl.school_id = current_setting('app.school_id')::uuid
  AND cl.code IN ('CLASS-MATH-101-SP26', 'CLASS-SCI-201-SP26', 'CLASS-ENG-101-SP26')
  AND st.school_id = current_setting('app.school_id')::uuid
  AND st.admission_number IN ('ADM-2026-001', 'ADM-2026-002', 'ADM-2026-003', 'ADM-2026-004', 'ADM-2026-005')
ON CONFLICT (school_id, class_id, student_id) DO NOTHING;

-- 3 students (Alice, Bob, Carol) in HIST
INSERT INTO app.enrollments (school_id, class_id, student_id, status)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  st.id,
  'active'
FROM app.classes cl
CROSS JOIN app.students st
WHERE cl.school_id = current_setting('app.school_id')::uuid
  AND cl.code = 'CLASS-HIST-101-SP26'
  AND st.school_id = current_setting('app.school_id')::uuid
  AND st.admission_number IN ('ADM-2026-001', 'ADM-2026-002', 'ADM-2026-003')
ON CONFLICT (school_id, class_id, student_id) DO NOTHING;

-- 2 students (Alice, Eve) in ART
INSERT INTO app.enrollments (school_id, class_id, student_id, status)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  st.id,
  'active'
FROM app.classes cl
CROSS JOIN app.students st
WHERE cl.school_id = current_setting('app.school_id')::uuid
  AND cl.code = 'CLASS-ART-101-SP26'
  AND st.school_id = current_setting('app.school_id')::uuid
  AND st.admission_number IN ('ADM-2026-001', 'ADM-2026-005')
ON CONFLICT (school_id, class_id, student_id) DO NOTHING;
