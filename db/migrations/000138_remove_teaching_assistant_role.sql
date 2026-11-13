-- Remove TEACHING_ASSISTANT from app.user_role.
--
-- Mirrors the removal of ROLES.TEACHING_ASSISTANT from packages/constants/src/roles.ts: the role is
-- no longer offered, assigned or authorized anywhere, so the database stops accepting it too.
--
-- PostgreSQL cannot drop a value from an enum, so the type is rebuilt: the old type is renamed, a new
-- app.user_role is created without the value, the four columns that use it are converted, and the old
-- type is dropped. Converting a column rewrites the table and rebuilds the constraints and indexes over
-- it (pk_user_roles, uq_invitations_active, ck_announcements_audience_shape) automatically. No policy,
-- view or function signature depends on the type; SQL and PL/pgSQL bodies that compare against role
-- literals are re-parsed on their next call and resolve to the new type.
--
-- Rows holding the value cannot be carried across, so they are removed first:
--   * app.user_roles   -- the assignment is revoked. It is not mapped to INSTRUCTOR, which would grant
--                         the holder strictly more than they had. The user account itself is kept; a
--                         user whose only role was TEACHING_ASSISTANT is left with none until an admin
--                         assigns one.
--   * app.invitations  -- a pending or historical invitation for the role is deleted (nothing
--                         references app.invitations).
--   * app.bulk_invites -- deleted; app.bulk_invite_recipients cascades.
--   * app.announcements addressed to the role -- recipients first (their foreign key is RESTRICT),
--                         then the announcement.
--
-- Every table touched is tenant-isolated with FORCE ROW LEVEL SECURITY and a migration session has no
-- tenant, so RLS is disabled for this transaction exactly as 000029/000118 do (ALTER TABLE holds ACCESS
-- EXCLUSIVE until commit; a failure rolls the flag back) and restored and asserted at the end.
--
-- app.can_message_teacher_about_student is the only function naming the value; it is redefined first,
-- unchanged except that the teacher must hold INSTRUCTOR.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. The messaging rule: the teacher must be an active INSTRUCTOR
-- ---------------------------------------------------------------------------------------------------

-- CREATE OR REPLACE keeps the owner (studafy_admin) and the EXECUTE grant to studafy_app from 000127.
CREATE OR REPLACE FUNCTION app.can_message_teacher_about_student(
  p_parent_user_id uuid,
  p_teacher_user_id uuid,
  p_student_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT
    EXISTS (
      SELECT 1
      FROM app.parent_child_links AS pcl
      WHERE pcl.school_id = current_setting('app.school_id')::uuid
        AND pcl.parent_user_id = p_parent_user_id
        AND pcl.student_id = p_student_id
    )
    AND EXISTS (
      SELECT 1
      FROM app.users AS u
      JOIN app.user_roles AS ur ON ur.user_id = u.id AND ur.school_id = u.school_id
      WHERE u.school_id = current_setting('app.school_id')::uuid
        AND u.id = p_parent_user_id
        AND u.status = 'active'
        AND ur.role = 'PARENT'
    )
    AND EXISTS (
      SELECT 1
      FROM app.users AS u
      JOIN app.user_roles AS ur ON ur.user_id = u.id AND ur.school_id = u.school_id
      WHERE u.school_id = current_setting('app.school_id')::uuid
        AND u.id = p_teacher_user_id
        AND u.status = 'active'
        AND ur.role = 'INSTRUCTOR'
    )
    AND EXISTS (
      SELECT 1
      FROM app.enrollments AS e
      JOIN app.classes AS c ON c.id = e.class_id AND c.school_id = e.school_id
      JOIN app.teachers AS t ON t.school_id = e.school_id AND t.user_id = p_teacher_user_id
      WHERE e.school_id = current_setting('app.school_id')::uuid
        AND e.student_id = p_student_id
        AND e.status = 'active'
        AND c.status IN ('planned', 'active')
        AND (
          c.lead_teacher_id = t.id
          OR EXISTS (
            SELECT 1
            FROM app.timetable_slots AS ts
            JOIN app.timetable_versions AS tv
              ON tv.id = ts.timetable_version_id AND tv.school_id = ts.school_id
            WHERE ts.school_id = c.school_id
              AND ts.class_id = c.id
              AND ts.teacher_id = t.id
              AND tv.status = 'approved'
          )
        )
    )
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 2. Remove every row holding the value
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.user_roles DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.invitations DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.bulk_invites DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.bulk_invite_recipients DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.announcements DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.announcement_recipients DISABLE ROW LEVEL SECURITY;

DELETE FROM app.user_roles WHERE role = 'TEACHING_ASSISTANT';
DELETE FROM app.invitations WHERE role = 'TEACHING_ASSISTANT';
DELETE FROM app.bulk_invites WHERE role = 'TEACHING_ASSISTANT';
DELETE FROM app.announcement_recipients AS ar
USING app.announcements AS a
WHERE ar.announcement_id = a.id AND a.audience_role = 'TEACHING_ASSISTANT';
DELETE FROM app.announcements WHERE audience_role = 'TEACHING_ASSISTANT';

-- ---------------------------------------------------------------------------------------------------
-- 3. Rebuild app.user_role without the value
-- ---------------------------------------------------------------------------------------------------

ALTER TYPE app.user_role RENAME TO user_role_with_teaching_assistant;

CREATE TYPE app.user_role AS ENUM (
  'SUPER_ADMIN',
  'ORG_ADMIN',
  'INSTRUCTOR',
  'STUDENT',
  'GUEST',
  'SUPPORT_AGENT',
  'FINANCE',
  'PARENT',
  'PRINCIPAL',
  'ATTENDANCE_OFFICER'
);

ALTER TABLE app.user_roles
  ALTER COLUMN role TYPE app.user_role USING role::text::app.user_role;
ALTER TABLE app.invitations
  ALTER COLUMN role TYPE app.user_role USING role::text::app.user_role;
ALTER TABLE app.bulk_invites
  ALTER COLUMN role TYPE app.user_role USING role::text::app.user_role;
ALTER TABLE app.announcements
  ALTER COLUMN audience_role TYPE app.user_role USING audience_role::text::app.user_role;

DROP TYPE app.user_role_with_teaching_assistant;

REVOKE ALL ON TYPE app.user_role FROM PUBLIC;
GRANT USAGE ON TYPE app.user_role TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 4. Restore row-level security on the tables disabled in section 2
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.bulk_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bulk_invites FORCE ROW LEVEL SECURITY;
ALTER TABLE app.bulk_invite_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bulk_invite_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE app.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.announcements FORCE ROW LEVEL SECURITY;
ALTER TABLE app.announcement_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.announcement_recipients FORCE ROW LEVEL SECURITY;

DO $assert_forced$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'app.user_roles', 'app.invitations', 'app.bulk_invites', 'app.bulk_invite_recipients',
    'app.announcements', 'app.announcement_recipients'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class
      WHERE oid = relation::regclass AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '% must leave this migration with ROW LEVEL SECURITY enabled and forced',
        relation USING ERRCODE = '42501';
    END IF;
  END LOOP;
END
$assert_forced$;

RESET ROLE;
