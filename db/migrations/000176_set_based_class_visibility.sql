-- role_scope_visibility on the class-owned tables the apps read most -- classes, timetable_slots,
-- materials, assignments, exams -- evaluated once per statement instead of once per row.
--
-- 000171 hoisted the admin and attendance-officer checks into `(SELECT ...)` InitPlans, so those
-- callers are already cheap. Everyone else -- teachers, students, parents, the apps' main audience
-- -- still runs app.can_read_class(class_id) on every candidate row: an admin probe, three
-- current_user_teacher_id() lookups, a classes and a timetable_slots probe for teaches_class, and two
-- enrollment EXISTS. SECURITY DEFINER functions with a SET clause are never inlined, so the planner
-- cannot fold any of that into the scan.
--
-- app.readable_class_ids() returns the same answer as a set, computed once: the classes the caller
-- leads or holds a timetable slot in (teaches_class), is enrolled in, or has a linked child enrolled
-- in. `class_id IN (SELECT app.readable_class_ids())` is an uncorrelated sublink, so it runs once as a
-- hashed SubPlan and each row costs a hash probe.
--
-- SAME VISIBLE ROWS. For a non-NULL id x, can_read_class(x) is admin OR teaches_class(x) OR the two
-- enrollment EXISTS, and each of the last three is exactly "x is in that branch of
-- readable_class_ids()" -- the branches below repeat their predicates column for column. The admin
-- branch is kept as 000171's hoisted check rather than folded into the set. For a NULL id both forms
-- are false without admin (every equality is NULL; `NULL IN (...)` is NULL). The attendance-officer
-- branch of classes and timetable_slots (000133's can_read_class_for_attendance) stays its own hoisted
-- check. tests/security/set-based-class-visibility.integration.test.ts proves the equivalence on live
-- data against the predicates replaced here.
--
-- Every other policy built on can_read_class / teaches_class (gradebooks, enrollments, attendance,
-- submissions, ...) is untouched; app.can_read_class itself is unchanged and still serves them.

SET ROLE studafy_admin;

-- SECURITY DEFINER owned by studafy_admin, like every 000037 helper, so its lookups see only
-- tenant_isolation and never recurse into the restrictive policies it serves (it reads classes and
-- timetable_slots, which this migration's policies cover).
CREATE FUNCTION app.readable_class_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
ROWS 20
AS $function$
  -- teaches_class: lead teacher
  SELECT c.id
  FROM app.classes AS c
  WHERE c.school_id = current_setting('app.school_id')::uuid
    AND c.lead_teacher_id = app.current_user_teacher_id()
  UNION
  -- teaches_class: holds a timetable slot (substitute / co-teacher)
  SELECT ts.class_id
  FROM app.timetable_slots AS ts
  WHERE ts.school_id = current_setting('app.school_id')::uuid
    AND ts.teacher_id = app.current_user_teacher_id()
  UNION
  -- the current user is a student enrolled in the class
  SELECT e.class_id
  FROM app.enrollments AS e
  JOIN app.students AS s ON s.id = e.student_id AND s.school_id = e.school_id
  WHERE e.school_id = current_setting('app.school_id')::uuid
    AND s.user_id = app.scope_user_id()
  UNION
  -- a child linked to the current user is enrolled in the class
  SELECT e.class_id
  FROM app.enrollments AS e
  JOIN app.parent_child_links AS pcl
    ON pcl.student_id = e.student_id AND pcl.school_id = e.school_id
  WHERE e.school_id = current_setting('app.school_id')::uuid
    AND pcl.parent_user_id = app.scope_user_id()
$function$;

REVOKE ALL ON FUNCTION app.readable_class_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.readable_class_ids() TO studafy_app;

-- 000171: admin OR officer OR can_read_class_for_attendance(id).
ALTER POLICY role_scope_visibility ON app.classes
  USING (
    (SELECT app.current_user_is_school_admin())
    OR (SELECT app.current_user_is_attendance_officer())
    OR id IN (SELECT app.readable_class_ids())
  );

-- 000133: can_read_class_for_attendance(class_id) = can_read_class(class_id) OR officer.
ALTER POLICY role_scope_visibility ON app.timetable_slots
  USING (
    (SELECT app.current_user_is_school_admin())
    OR (SELECT app.current_user_is_attendance_officer())
    OR class_id IN (SELECT app.readable_class_ids())
  );

-- 000171: admin OR can_read_class(class_id). Attendance officers do not read materials.
ALTER POLICY role_scope_visibility ON app.materials
  USING (
    (SELECT app.current_user_is_school_admin())
    OR class_id IN (SELECT app.readable_class_ids())
  );

-- 000037: can_read_class(class_id).
ALTER POLICY role_scope_visibility ON app.assignments
  USING (
    (SELECT app.current_user_is_school_admin())
    OR class_id IN (SELECT app.readable_class_ids())
  );

-- 000037: can_read_class(class_id).
ALTER POLICY role_scope_visibility ON app.exams
  USING (
    (SELECT app.current_user_is_school_admin())
    OR class_id IN (SELECT app.readable_class_ids())
  );

RESET ROLE;
