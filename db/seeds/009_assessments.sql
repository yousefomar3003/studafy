-- Seed assignments and submissions.
-- Depends on: 006 (classes), 004 (students, teachers for user refs).

SET LOCAL ROLE studafy_admin;

-- Assignments for MATH-101
INSERT INTO app.assignments (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, description, status, assigned_at, due_at, max_score, allow_late_submission)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  u.id,
  u.id,
  'Problem Set 1',
  'Solve equations 1-20 from Chapter 3',
  'published',
  '2026-01-12 08:00:00+00'::timestamptz,
  '2026-01-19 23:59:00+00'::timestamptz,
  100,
  false
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-MATH-101-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT DO NOTHING;

INSERT INTO app.assignments (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, description, status, assigned_at, due_at, max_score, allow_late_submission)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  u.id,
  u.id,
  'Problem Set 2',
  'Quadratic functions and graphing',
  'published',
  '2026-02-02 08:00:00+00'::timestamptz,
  '2026-02-09 23:59:00+00'::timestamptz,
  100,
  true
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-MATH-101-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT DO NOTHING;

-- Assignments for SCI-201
INSERT INTO app.assignments (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, description, status, assigned_at, due_at, max_score, allow_late_submission)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  u.id,
  u.id,
  'Lab Report: Cell Structure',
  'Write a lab report on the microscope observation of plant and animal cells',
  'published',
  '2026-01-15 08:00:00+00'::timestamptz,
  '2026-01-22 23:59:00+00'::timestamptz,
  50,
  false
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-SCI-201-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.science@demo-academy.local'
ON CONFLICT DO NOTHING;

-- Assignments for ENG-101
INSERT INTO app.assignments (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, description, status, assigned_at, due_at, max_score, allow_late_submission)
SELECT
  current_setting('app.school_id')::uuid,
  cl.id,
  u.id,
  u.id,
  'Narrative Essay',
  'Write a 1000-word personal narrative essay',
  'published',
  '2026-01-10 08:00:00+00'::timestamptz,
  '2026-01-24 23:59:00+00'::timestamptz,
  100,
  true
FROM app.classes cl
CROSS JOIN app.users u
WHERE cl.school_id = current_setting('app.school_id')::uuid AND cl.code = 'CLASS-ENG-101-SP26'
  AND u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.english@demo-academy.local'
ON CONFLICT DO NOTHING;

-- Submissions for Problem Set 1 (Math) - some graded, some submitted
INSERT INTO app.assignment_submissions (school_id, assignment_id, student_id, last_edited_by_user_id, graded_by_user_id, status, submitted_at, graded_at, score, feedback)
SELECT
  current_setting('app.school_id')::uuid,
  a.id,
  s.id,
  s_user.id,
  t_user.id,
  'graded',
  '2026-01-17 14:30:00+00'::timestamptz,
  '2026-01-18 10:00:00+00'::timestamptz,
  92,
  'Excellent work on the polynomial equations.'
FROM app.assignments a
CROSS JOIN app.students s
CROSS JOIN app.users s_user
CROSS JOIN app.users t_user
WHERE a.school_id = current_setting('app.school_id')::uuid AND a.title = 'Problem Set 1'
  AND s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-001'
  AND s_user.school_id = current_setting('app.school_id')::uuid AND s_user.normalized_email = 'student.alice@demo-academy.local'
  AND t_user.school_id = current_setting('app.school_id')::uuid AND t_user.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT (school_id, assignment_id, student_id) DO NOTHING;

INSERT INTO app.assignment_submissions (school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at)
SELECT
  current_setting('app.school_id')::uuid,
  a.id,
  s.id,
  s_user.id,
  'submitted',
  '2026-01-18 09:00:00+00'::timestamptz
FROM app.assignments a
CROSS JOIN app.students s
CROSS JOIN app.users s_user
WHERE a.school_id = current_setting('app.school_id')::uuid AND a.title = 'Problem Set 1'
  AND s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-002'
  AND s_user.school_id = current_setting('app.school_id')::uuid AND s_user.normalized_email = 'student.bob@demo-academy.local'
ON CONFLICT (school_id, assignment_id, student_id) DO NOTHING;

INSERT INTO app.assignment_submissions (school_id, assignment_id, student_id, last_edited_by_user_id, graded_by_user_id, status, submitted_at, graded_at, score, feedback)
SELECT
  current_setting('app.school_id')::uuid,
  a.id,
  s.id,
  s_user.id,
  t_user.id,
  'graded',
  '2026-01-16 11:00:00+00'::timestamptz,
  '2026-01-17 16:00:00+00'::timestamptz,
  78,
  'Good effort. Review the factoring techniques in section 3.4.'
FROM app.assignments a
CROSS JOIN app.students s
CROSS JOIN app.users s_user
CROSS JOIN app.users t_user
WHERE a.school_id = current_setting('app.school_id')::uuid AND a.title = 'Problem Set 1'
  AND s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-003'
  AND s_user.school_id = current_setting('app.school_id')::uuid AND s_user.normalized_email = 'student.carol@demo-academy.local'
  AND t_user.school_id = current_setting('app.school_id')::uuid AND t_user.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT (school_id, assignment_id, student_id) DO NOTHING;

-- Submission for Narrative Essay (English) - graded
INSERT INTO app.assignment_submissions (school_id, assignment_id, student_id, last_edited_by_user_id, graded_by_user_id, status, submitted_at, graded_at, score, feedback)
SELECT
  current_setting('app.school_id')::uuid,
  a.id,
  s.id,
  s_user.id,
  t_user.id,
  'graded',
  '2026-01-22 15:00:00+00'::timestamptz,
  '2026-01-23 09:00:00+00'::timestamptz,
  88,
  'Strong narrative voice. Watch for run-on sentences in paragraph 3.'
FROM app.assignments a
CROSS JOIN app.students s
CROSS JOIN app.users s_user
CROSS JOIN app.users t_user
WHERE a.school_id = current_setting('app.school_id')::uuid AND a.title = 'Narrative Essay'
  AND s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-001'
  AND s_user.school_id = current_setting('app.school_id')::uuid AND s_user.normalized_email = 'student.alice@demo-academy.local'
  AND t_user.school_id = current_setting('app.school_id')::uuid AND t_user.normalized_email = 'teacher.english@demo-academy.local'
ON CONFLICT (school_id, assignment_id, student_id) DO NOTHING;
