-- Teacher-initiated parent <-> teacher messaging: a teacher may now open a thread with a parent of a
-- child they teach, not only reply to one a parent started (000127).
--
-- WHO MAY TALK TO WHOM is unchanged and still lives once, in app.can_message_teacher_about_student:
-- the parent is linked to the child in app.parent_child_links, and the teacher is an active
-- INSTRUCTOR / TEACHING_ASSISTANT who teaches a class the child is currently enrolled in (lead
-- teacher, or a slot in an approved timetable). The rule is symmetric -- it names the parent, the
-- teacher and the child, not who asks -- so the same function now guards both directions.
--
-- 1. The rule gains one clause: the parent must also be an active user holding PARENT, the role that
--    carries message:read -- the mirror of the existing teacher clause, so a teacher can never open
--    a thread with a guardian account that could not read it (invited, suspended, archived, or not
--    a parent). For a parent opening a thread this is already true of the signed-in caller.
--
-- 2. The INSERT policy. message_conversations_parent_insert allowed only parent_user_id =
--    app.scope_user_id(). PostgreSQL ANDs RESTRICTIVE policies, so a second teacher-only policy
--    alongside it would demand a caller be both participants at once; the policy is replaced by one
--    that accepts either participant opening the thread as themselves, under the same rule.
--
-- Deduplication is untouched: uq_message_conversations_participants keys a thread on (school,
-- parent, teacher, child) whoever opens it, so a teacher opening a thread a parent already started
-- (or the reverse) lands on the existing row through the API's ON CONFLICT DO NOTHING get-or-create.
-- Read, update and message policies were already participant-symmetric and are unchanged.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. The messaging rule: the parent must be an active PARENT
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
        AND ur.role IN ('INSTRUCTOR', 'TEACHING_ASSISTANT')
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
-- 2. Either participant opens a thread, as themselves
-- ---------------------------------------------------------------------------------------------------

DROP POLICY message_conversations_parent_insert ON app.message_conversations;

CREATE POLICY message_conversations_participant_insert ON app.message_conversations
  AS RESTRICTIVE FOR INSERT TO studafy_app
  WITH CHECK (
    app.scope_user_id() IN (parent_user_id, teacher_user_id)
    AND app.can_message_teacher_about_student(parent_user_id, teacher_user_id, student_id)
  );

RESET ROLE;
