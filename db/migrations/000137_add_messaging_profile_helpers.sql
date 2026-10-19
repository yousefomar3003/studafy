-- Participant profile details for parent <-> teacher messaging: what a thread's participant may
-- learn about the person on the other side (GET /api/messaging/conversations/{id}/profile).
--
-- WHAT EACH SIDE SEES.
-- A parent viewing their child's teacher sees the classes that teacher teaches which the thread's
-- child is currently enrolled in (class, course, subject), and the distinct subject names across
-- all the teacher's current classes -- what the teacher teaches, not whom. A teacher viewing a
-- parent sees that parent's linked children whom THIS teacher currently teaches, with those
-- classes, plus the thread's own child (whose relationship the thread is about) even after the
-- child has left the teacher's classes. The parent's other children stay hidden. No contact
-- details (email, phone) are exposed by anything here.
--
-- "Teaches" is the rule app.can_message_teacher_about_student (000127/000130) uses: the class's lead
-- teacher, or a slot in an approved (live) timetable version, on a planned or active class, with an
-- active enrollment.
--
-- WHY SECURITY DEFINER.
-- The rows these answers come from belong to other users: a parent cannot read a teacher's classes
-- or the subjects behind them, and a teacher's view of app.students and app.parent_child_links is
-- scoped by role_scope_visibility. Each function is read-only, pinned to
-- current_setting('app.school_id'), keyed on one thread, and answers only to that thread's
-- participant on the viewing side -- anyone else gets no rows.

SET ROLE studafy_admin;

-- The teacher's classes the thread's child is enrolled in. Viewer: the thread's parent.
CREATE FUNCTION app.message_profile_teacher_classes(p_conversation_id uuid)
RETURNS TABLE (class_id uuid, class_code text, course_name text, subject_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT DISTINCT c.id, c.code, co.name, su.name
  FROM app.message_conversations AS mc
  JOIN app.teachers AS t
    ON t.school_id = mc.school_id AND t.user_id = mc.teacher_user_id
  JOIN app.enrollments AS e
    ON e.school_id = mc.school_id AND e.student_id = mc.student_id AND e.status = 'active'
  JOIN app.classes AS c
    ON c.id = e.class_id AND c.school_id = e.school_id AND c.status IN ('planned', 'active')
  LEFT JOIN app.courses AS co ON co.id = c.course_id AND co.school_id = c.school_id
  LEFT JOIN app.subjects AS su ON su.id = co.subject_id AND su.school_id = co.school_id
  WHERE mc.school_id = current_setting('app.school_id')::uuid
    AND mc.id = p_conversation_id
    AND mc.parent_user_id = app.scope_user_id()
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
$function$;

-- Distinct subject names across all of the teacher's current classes. Viewer: the thread's parent.
CREATE FUNCTION app.message_profile_teacher_subjects(p_conversation_id uuid)
RETURNS TABLE (subject_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT DISTINCT su.name
  FROM app.message_conversations AS mc
  JOIN app.teachers AS t
    ON t.school_id = mc.school_id AND t.user_id = mc.teacher_user_id
  JOIN app.classes AS c
    ON c.school_id = mc.school_id AND c.status IN ('planned', 'active')
  JOIN app.courses AS co ON co.id = c.course_id AND co.school_id = c.school_id
  JOIN app.subjects AS su ON su.id = co.subject_id AND su.school_id = co.school_id
  WHERE mc.school_id = current_setting('app.school_id')::uuid
    AND mc.id = p_conversation_id
    AND mc.parent_user_id = app.scope_user_id()
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
$function$;

-- The parent's linked children the viewing teacher currently teaches, one row per (child, taught
-- class), plus the thread's own child with a NULL class when the teacher no longer teaches them.
-- Viewer: the thread's teacher.
CREATE FUNCTION app.message_profile_parent_children(p_conversation_id uuid)
RETURNS TABLE (
  student_id uuid,
  student_name text,
  relationship text,
  is_conversation_student boolean,
  class_id uuid,
  class_code text,
  course_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  WITH conv AS (
    SELECT mc.school_id, mc.parent_user_id, mc.teacher_user_id, mc.student_id
    FROM app.message_conversations AS mc
    WHERE mc.school_id = current_setting('app.school_id')::uuid
      AND mc.id = p_conversation_id
      AND mc.teacher_user_id = app.scope_user_id()
  ),
  taught_classes AS (
    SELECT c.id, c.code, co.name AS course_name
    FROM conv
    JOIN app.teachers AS t
      ON t.school_id = conv.school_id AND t.user_id = conv.teacher_user_id
    JOIN app.classes AS c
      ON c.school_id = conv.school_id AND c.status IN ('planned', 'active')
    LEFT JOIN app.courses AS co ON co.id = c.course_id AND co.school_id = c.school_id
    WHERE c.lead_teacher_id = t.id
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
  ),
  children AS (
    SELECT pcl.student_id, pcl.relationship::text AS relationship
    FROM conv
    JOIN app.parent_child_links AS pcl
      ON pcl.school_id = conv.school_id AND pcl.parent_user_id = conv.parent_user_id
  ),
  taught_enrollments AS (
    SELECT DISTINCT e.student_id, tc.id, tc.code, tc.course_name
    FROM conv
    JOIN app.enrollments AS e ON e.school_id = conv.school_id AND e.status = 'active'
    JOIN taught_classes AS tc ON tc.id = e.class_id
    WHERE e.student_id IN (SELECT ch.student_id FROM children AS ch)
  )
  SELECT
    ch.student_id,
    coalesce(s.preferred_name, s.first_name) || ' ' || s.last_name,
    ch.relationship,
    ch.student_id = conv.student_id,
    te.id,
    te.code,
    te.course_name
  FROM children AS ch
  CROSS JOIN conv
  JOIN app.students AS s ON s.id = ch.student_id AND s.school_id = conv.school_id
  LEFT JOIN taught_enrollments AS te ON te.student_id = ch.student_id
  WHERE te.id IS NOT NULL OR ch.student_id = conv.student_id
$function$;

ALTER FUNCTION app.message_profile_teacher_classes(uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.message_profile_teacher_subjects(uuid) OWNER TO studafy_admin;
ALTER FUNCTION app.message_profile_parent_children(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION
  app.message_profile_teacher_classes(uuid),
  app.message_profile_teacher_subjects(uuid),
  app.message_profile_parent_children(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.message_profile_teacher_classes(uuid),
  app.message_profile_teacher_subjects(uuid),
  app.message_profile_parent_children(uuid)
TO studafy_app;

RESET ROLE;
