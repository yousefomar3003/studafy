-- Seed users in all 7 roles with OAuth identities for local mocked login.
-- Each user gets a fake Google OAuth identity so the auth layer can resolve them.
-- All rows are tenant-scoped (school_id = app.school_id).

SET LOCAL ROLE studafy_admin;

-- SUPER_ADMIN
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'admin@demo-academy.local',
  'admin@demo-academy.local',
  'Platform Admin',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'SUPER_ADMIN'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'admin@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-admin-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'admin@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- ORG_ADMIN
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'principal@demo-academy.local',
  'principal@demo-academy.local',
  'Dr. Rebecca Torres',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'ORG_ADMIN'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'principal@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-principal-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'principal@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- INSTRUCTOR: Ms. Sarah Chen (Math)
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'teacher.math@demo-academy.local',
  'teacher.math@demo-academy.local',
  'Ms. Sarah Chen',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'INSTRUCTOR'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-teacher-math-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'teacher.math@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- INSTRUCTOR: Mr. James Wilson (Science)
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'teacher.science@demo-academy.local',
  'teacher.science@demo-academy.local',
  'Mr. James Wilson',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'INSTRUCTOR'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'teacher.science@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-teacher-science-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'teacher.science@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- INSTRUCTOR: Ms. Maria Garcia (English)
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'teacher.english@demo-academy.local',
  'teacher.english@demo-academy.local',
  'Ms. Maria Garcia',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'INSTRUCTOR'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'teacher.english@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-teacher-english-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'teacher.english@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- TEACHING_ASSISTANT: Mr. David Kim (History)
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'ta.history@demo-academy.local',
  'ta.history@demo-academy.local',
  'Mr. David Kim',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'TEACHING_ASSISTANT'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'ta.history@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-ta-history-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'ta.history@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- STUDENT: Alice Johnson
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'student.alice@demo-academy.local',
  'student.alice@demo-academy.local',
  'Alice Johnson',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'STUDENT'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.alice@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-student-alice-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.alice@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- STUDENT: Bob Smith
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'student.bob@demo-academy.local',
  'student.bob@demo-academy.local',
  'Bob Smith',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'STUDENT'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.bob@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-student-bob-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.bob@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- STUDENT: Carol Williams
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'student.carol@demo-academy.local',
  'student.carol@demo-academy.local',
  'Carol Williams',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'STUDENT'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.carol@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-student-carol-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.carol@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- STUDENT: Dave Brown
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'student.dave@demo-academy.local',
  'student.dave@demo-academy.local',
  'Dave Brown',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'STUDENT'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.dave@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-student-dave-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.dave@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- STUDENT: Eve Davis
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'student.eve@demo-academy.local',
  'student.eve@demo-academy.local',
  'Eve Davis',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'STUDENT'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.eve@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-student-eve-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'student.eve@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- GUEST (parent): Frank Johnson (Alice's father)
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'parent.frank@demo-academy.local',
  'parent.frank@demo-academy.local',
  'Frank Johnson',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'GUEST'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'parent.frank@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-parent-frank-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'parent.frank@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;

-- SUPPORT_AGENT
INSERT INTO app.users (school_id, email, normalized_email, display_name, status, email_verified_at)
SELECT
  current_setting('app.school_id')::uuid,
  'support@demo-academy.local',
  'support@demo-academy.local',
  'Help Desk',
  'active',
  CURRENT_TIMESTAMP
ON CONFLICT (school_id, normalized_email) DO NOTHING;

INSERT INTO app.user_roles (school_id, user_id, role)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'SUPPORT_AGENT'::app.user_role
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'support@demo-academy.local'
ON CONFLICT (school_id, user_id, role) DO NOTHING;

INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
SELECT
  current_setting('app.school_id')::uuid,
  id,
  'google',
  'google-support-001'
FROM app.users
WHERE school_id = current_setting('app.school_id')::uuid
  AND normalized_email = 'support@demo-academy.local'
ON CONFLICT (provider, subject) DO NOTHING;
