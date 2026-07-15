-- Seed gradebooks, grade submissions, and individual grades.
-- Depends on: 006 (classes), 004 (students), 009 (submissions for graded ones).

SET LOCAL ROLE studafy_admin;

-- Gradebooks (one per class)
INSERT INTO app.gradebooks (school_id, class_id, status)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'active'
FROM app.classes
WHERE school_id = current_setting('app.school_id')::uuid
  AND code IN ('CLASS-MATH-101-SP26', 'CLASS-SCI-201-SP26', 'CLASS-ENG-101-SP26', 'CLASS-HIST-101-SP26', 'CLASS-ART-101-SP26')
ON CONFLICT (school_id, class_id) DO NOTHING;

-- Grade submission for Alice in MATH (published)
INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id, submitted_by_user_id, decided_by_user_id, status)
SELECT
  current_setting('app.school_id')::uuid,
  gb.id,
  s.id,
  t_user.id,
  t_user.id,
  'published'
FROM app.gradebooks gb
CROSS JOIN app.students s
CROSS JOIN app.users t_user
WHERE gb.school_id = current_setting('app.school_id')::uuid
  AND gb.class_id = (SELECT id FROM app.classes WHERE school_id = current_setting('app.school_id')::uuid AND code = 'CLASS-MATH-101-SP26')
  AND s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-001'
  AND t_user.school_id = current_setting('app.school_id')::uuid AND t_user.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT (school_id, gradebook_id, student_id) DO NOTHING;

-- Individual grades for Alice in MATH
INSERT INTO app.grades (school_id, grade_submission_id, score, max_score, weight, label)
SELECT
  current_setting('app.school_id')::uuid,
  gs.id,
  92,
  100,
  1,
  'Problem Set 1'
FROM app.grade_submissions gs
WHERE gs.school_id = current_setting('app.school_id')::uuid
  AND gs.gradebook_id = (SELECT id FROM app.gradebooks WHERE school_id = current_setting('app.school_id')::uuid AND class_id = (SELECT id FROM app.classes WHERE school_id = current_setting('app.school_id')::uuid AND code = 'CLASS-MATH-101-SP26'))
  AND gs.student_id = (SELECT id FROM app.students WHERE school_id = current_setting('app.school_id')::uuid AND admission_number = 'ADM-2026-001')
ON CONFLICT DO NOTHING;

-- Grade submission for Bob in MATH (submitted, awaiting approval)
INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id, submitted_by_user_id, status)
SELECT
  current_setting('app.school_id')::uuid,
  gb.id,
  s.id,
  t_user.id,
  'submitted'
FROM app.gradebooks gb
CROSS JOIN app.students s
CROSS JOIN app.users t_user
WHERE gb.school_id = current_setting('app.school_id')::uuid
  AND gb.class_id = (SELECT id FROM app.classes WHERE school_id = current_setting('app.school_id')::uuid AND code = 'CLASS-MATH-101-SP26')
  AND s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-002'
  AND t_user.school_id = current_setting('app.school_id')::uuid AND t_user.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT (school_id, gradebook_id, student_id) DO NOTHING;

-- Grade submission for Alice in ENG (published)
INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id, submitted_by_user_id, decided_by_user_id, status)
SELECT
  current_setting('app.school_id')::uuid,
  gb.id,
  s.id,
  t_user.id,
  t_user.id,
  'published'
FROM app.gradebooks gb
CROSS JOIN app.students s
CROSS JOIN app.users t_user
WHERE gb.school_id = current_setting('app.school_id')::uuid
  AND gb.class_id = (SELECT id FROM app.classes WHERE school_id = current_setting('app.school_id')::uuid AND code = 'CLASS-ENG-101-SP26')
  AND s.school_id = current_setting('app.school_id')::uuid AND s.admission_number = 'ADM-2026-001'
  AND t_user.school_id = current_setting('app.school_id')::uuid AND t_user.normalized_email = 'teacher.english@demo-academy.local'
ON CONFLICT (school_id, gradebook_id, student_id) DO NOTHING;

-- Individual grades for Alice in ENG
INSERT INTO app.grades (school_id, grade_submission_id, score, max_score, weight, label)
SELECT
  current_setting('app.school_id')::uuid,
  gs.id,
  88,
  100,
  1,
  'Narrative Essay'
FROM app.grade_submissions gs
WHERE gs.school_id = current_setting('app.school_id')::uuid
  AND gs.gradebook_id = (SELECT id FROM app.gradebooks WHERE school_id = current_setting('app.school_id')::uuid AND class_id = (SELECT id FROM app.classes WHERE school_id = current_setting('app.school_id')::uuid AND code = 'CLASS-ENG-101-SP26'))
  AND gs.student_id = (SELECT id FROM app.students WHERE school_id = current_setting('app.school_id')::uuid AND admission_number = 'ADM-2026-001')
ON CONFLICT DO NOTHING;
