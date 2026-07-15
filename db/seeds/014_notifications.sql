-- Seed notifications and user devices.
-- Depends on: 003 (users).

SET LOCAL ROLE studafy_admin;

-- Notifications for Alice (student)
INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata, read_at, created_at)
SELECT
  current_setting('app.school_id')::uuid,
  u.id,
  'ENROLLMENT_APPROVED'::app.notification_type,
  'Enrollment Approved',
  'Your enrollment in MATH-101 has been approved.',
  '{"class_code": "CLASS-MATH-101-SP26"}'::jsonb,
  '2026-01-10 10:00:00+00'::timestamptz,
  '2026-01-10 09:00:00+00'::timestamptz
FROM app.users u
WHERE u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'student.alice@demo-academy.local'
ON CONFLICT DO NOTHING;

INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, created_at)
SELECT
  current_setting('app.school_id')::uuid,
  u.id,
  'ASSIGNMENT_DUE_SOON'::app.notification_type,
  'Problem Set 1 Due Tomorrow',
  'Problem Set 1 for MATH-101 is due tomorrow at 23:59 UTC.',
  '2026-01-18 20:00:00+00'::timestamptz
FROM app.users u
WHERE u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'student.alice@demo-academy.local'
ON CONFLICT DO NOTHING;

INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, created_at)
SELECT
  current_setting('app.school_id')::uuid,
  u.id,
  'GRADE_POSTED'::app.notification_type,
  'Grade Posted: Problem Set 1',
  'Your grade for Problem Set 1 in MATH-101 has been posted.',
  '2026-01-18 12:00:00+00'::timestamptz
FROM app.users u
WHERE u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'student.alice@demo-academy.local'
ON CONFLICT DO NOTHING;

INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, created_at)
SELECT
  current_setting('app.school_id')::uuid,
  u.id,
  'COURSE_PUBLISHED'::app.notification_type,
  'New Course Available',
  'ART-101 has been published and is now open for enrollment.',
  '2026-01-08 14:00:00+00'::timestamptz
FROM app.users u
WHERE u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'student.alice@demo-academy.local'
ON CONFLICT DO NOTHING;

-- Notification for Math Teacher
INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata, created_at)
SELECT
  current_setting('app.school_id')::uuid,
  u.id,
  'DISCUSSION_REPLY'::app.notification_type,
  'New Discussion Post',
  'A student asked a question in MATH-101 discussion board.',
  '{"class_code": "CLASS-MATH-101-SP26", "student": "Alice"}'::jsonb,
  '2026-07-08 11:00:00+00'::timestamptz
FROM app.users u
WHERE u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT DO NOTHING;

-- Notification for Science Teacher
INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, created_at)
SELECT
  current_setting('app.school_id')::uuid,
  u.id,
  'ENROLLMENT_APPROVED'::app.notification_type,
  'New Student Enrolled',
  'A new student has been enrolled in SCI-201.',
  '2026-01-12 09:00:00+00'::timestamptz
FROM app.users u
WHERE u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.science@demo-academy.local'
ON CONFLICT DO NOTHING;

-- Devices for Alice (iOS + web)
INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform, last_seen)
SELECT
  current_setting('app.school_id')::uuid,
  u.id,
  'fcm-token-alice-ios-001',
  'ios'::app.device_platform,
  '2026-07-14 18:30:00+00'::timestamptz
FROM app.users u
WHERE u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'student.alice@demo-academy.local'
ON CONFLICT (user_id, fcm_token) DO NOTHING;

INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform, last_seen)
SELECT
  current_setting('app.school_id')::uuid,
  u.id,
  'fcm-token-alice-web-001',
  'web'::app.device_platform,
  '2026-07-15 08:00:00+00'::timestamptz
FROM app.users u
WHERE u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'student.alice@demo-academy.local'
ON CONFLICT (user_id, fcm_token) DO NOTHING;

-- Device for Bob (Android)
INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform, last_seen)
SELECT
  current_setting('app.school_id')::uuid,
  u.id,
  'fcm-token-bob-android-001',
  'android'::app.device_platform,
  '2026-07-15 07:45:00+00'::timestamptz
FROM app.users u
WHERE u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'student.bob@demo-academy.local'
ON CONFLICT (user_id, fcm_token) DO NOTHING;

-- Device for Math Teacher (web)
INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform, last_seen)
SELECT
  current_setting('app.school_id')::uuid,
  u.id,
  'fcm-token-math-teacher-web-001',
  'web'::app.device_platform,
  '2026-07-15 09:00:00+00'::timestamptz
FROM app.users u
WHERE u.school_id = current_setting('app.school_id')::uuid AND u.normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT (user_id, fcm_token) DO NOTHING;
