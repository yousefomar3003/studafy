-- Seed academic structure: year, terms, subjects, courses, rooms.
-- Depends on: 002 (school must exist).

SET LOCAL ROLE studafy_admin;

-- Academic year 2025-2026
INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
SELECT
  current_setting('app.school_id')::uuid,
  'AY-2025-2026',
  'Academic Year 2025-2026',
  '2025-09-01'::date,
  '2026-06-30'::date,
  'active'
ON CONFLICT (school_id, code) DO NOTHING;

-- Terms
INSERT INTO app.terms (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
SELECT
  current_setting('app.school_id')::uuid,
  ay.id,
  'FALL-2025',
  'Fall 2025',
  1,
  '2025-09-01'::date,
  '2025-12-19'::date,
  'closed'
FROM app.academic_years ay
WHERE ay.school_id = current_setting('app.school_id')::uuid
  AND ay.code = 'AY-2025-2026'
ON CONFLICT (school_id, academic_year_id, code) DO NOTHING;

INSERT INTO app.terms (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
SELECT
  current_setting('app.school_id')::uuid,
  ay.id,
  'SPRING-2026',
  'Spring 2026',
  2,
  '2026-01-05'::date,
  '2026-05-22'::date,
  'active'
FROM app.academic_years ay
WHERE ay.school_id = current_setting('app.school_id')::uuid
  AND ay.code = 'AY-2025-2026'
ON CONFLICT (school_id, academic_year_id, code) DO NOTHING;

INSERT INTO app.terms (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
SELECT
  current_setting('app.school_id')::uuid,
  ay.id,
  'SUMMER-2026',
  'Summer 2026',
  3,
  '2026-06-01'::date,
  '2026-07-31'::date,
  'planned'
FROM app.academic_years ay
WHERE ay.school_id = current_setting('app.school_id')::uuid
  AND ay.code = 'AY-2025-2026'
ON CONFLICT (school_id, academic_year_id, code) DO NOTHING;

-- Subjects
INSERT INTO app.subjects (school_id, code, name, description, status)
VALUES
  (current_setting('app.school_id')::uuid, 'MATH', 'Mathematics', 'Mathematical concepts and problem solving', 'active'),
  (current_setting('app.school_id')::uuid, 'SCI', 'Science', 'Natural sciences including biology, chemistry, and physics', 'active'),
  (current_setting('app.school_id')::uuid, 'ENG', 'English', 'English language arts, writing, and literature', 'active'),
  (current_setting('app.school_id')::uuid, 'HIST', 'History', 'World history and social studies', 'active'),
  (current_setting('app.school_id')::uuid, 'ART', 'Art', 'Visual arts and creative expression', 'active')
ON CONFLICT (school_id, code) DO NOTHING;

-- Courses (one per subject)
INSERT INTO app.courses (school_id, subject_id, code, name, description, status)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'MATH-101',
  'Algebra I',
  'Introduction to algebraic concepts, equations, and functions',
  'active'
FROM app.subjects s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.code = 'MATH'
ON CONFLICT (school_id, code) DO NOTHING;

INSERT INTO app.courses (school_id, subject_id, code, name, description, status)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'SCI-201',
  'Biology',
  'Study of living organisms, cells, genetics, and ecosystems',
  'active'
FROM app.subjects s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.code = 'SCI'
ON CONFLICT (school_id, code) DO NOTHING;

INSERT INTO app.courses (school_id, subject_id, code, name, description, status)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'ENG-101',
  'Composition',
  'Essay writing, grammar, and critical reading',
  'active'
FROM app.subjects s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.code = 'ENG'
ON CONFLICT (school_id, code) DO NOTHING;

INSERT INTO app.courses (school_id, subject_id, code, name, description, status)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'HIST-101',
  'World History',
  'Survey of major world civilizations and events',
  'active'
FROM app.subjects s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.code = 'HIST'
ON CONFLICT (school_id, code) DO NOTHING;

INSERT INTO app.courses (school_id, subject_id, code, name, description, status)
SELECT
  current_setting('app.school_id')::uuid,
  s.id,
  'ART-101',
  'Visual Arts',
  'Drawing, painting, and art appreciation',
  'active'
FROM app.subjects s
WHERE s.school_id = current_setting('app.school_id')::uuid AND s.code = 'ART'
ON CONFLICT (school_id, code) DO NOTHING;

-- Rooms
INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building, floor)
VALUES
  (current_setting('app.school_id')::uuid, 'ROOM-101', 'Lecture Hall A', 'physical', 40, 'Main', '1'),
  (current_setting('app.school_id')::uuid, 'ROOM-201', 'Science Lab B', 'physical', 30, 'Science', '1'),
  (current_setting('app.school_id')::uuid, 'ROOM-301', 'Classroom C', 'physical', 35, 'Main', '2'),
  (current_setting('app.school_id')::uuid, 'ROOM-401', 'Art Studio', 'physical', 25, 'Arts', '1')
ON CONFLICT (school_id, code) DO NOTHING;

INSERT INTO app.rooms (school_id, code, name, room_type, virtual_url)
VALUES
  (current_setting('app.school_id')::uuid, 'ROOM-V01', 'Virtual Classroom', 'virtual', 'https://zoom.us/j/demo-classroom')
ON CONFLICT (school_id, code) DO NOTHING;
