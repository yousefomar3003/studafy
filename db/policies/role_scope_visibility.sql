-- Canonical reference copy of the ST-085 intra-tenant row-scope policies.
--
-- The authoritative DDL lives in db/migrations/000035_add_role_scope_rls_policies.sql; this file is the
-- readable copy kept alongside the other policy references (tenant_isolation.sql,
-- evaluation_visibility.sql, notification_user_isolation.sql). Migrations are immutable, so any change
-- to these policies ships as a new forward migration and is reflected here.
--
-- WHAT THIS LAYER ADDS
-- tenant_isolation answers "which school?"; these RESTRICTIVE policies answer "which rows within the
-- school may THIS user see?" for the academic tables. A restrictive policy ANDs with the permissive
-- tenant_isolation policy, so a row is readable only when the school matches app.school_id AND the
-- caller's role/relationship grants access.
--
-- ROLE MODEL (no PARENT role exists)
--   * Admin   -> app.user_roles.role IN ('ORG_ADMIN','SUPER_ADMIN'); full school-wide read access.
--   * Teacher -> app.teachers row; scoped to classes they lead (classes.lead_teacher_id) or teach via
--                a timetable slot (timetable_slots.teacher_id).
--   * Student -> app.students row; scoped to their own records and their classes.
--   * Parent  -> presence in app.parent_child_links.parent_user_id; scoped to linked children.
--
-- WHY ONE POLICY PER TABLE WITH ORed SCOPES
-- Restrictive policies AND together, so teacher/parent/student scopes are ORed inside a single policy
-- (plus an admin escape hatch) rather than declared as three separate policies that no one could
-- satisfy at once. Same shape as teacher_evaluation_visibility ("teacher OR evaluator").
--
-- WHY SECURITY DEFINER HELPERS + "TO studafy_app" POLICIES
-- The predicates read relationship tables that themselves carry role_scope_visibility policies. Each
-- helper is SECURITY DEFINER owned by studafy_admin and each policy is TO studafy_app, so a helper's
-- lookups run as studafy_admin and see only tenant_isolation (TO PUBLIC) -- never these restrictive
-- policies -- which breaks the recursion while keeping every lookup pinned to the current school.
--
-- SCOPE: SELECT only. Writes remain governed by tenant_isolation's WITH CHECK plus the application
-- permission matrix.
--
-- Prerequisites (all satisfied by migration 000035):
--   1. app.apply_tenant_isolation('app', <table>) already installed on each table.
--   2. The SECURITY DEFINER helpers below exist, owned by studafy_admin, EXECUTE granted to studafy_app.
--   3. The application sets app.school_id and app.user_id per transaction (withTenantTx).

-- Helper predicates (bodies in migration 000035):
--   app.scope_user_id()                     -> uuid    NULLIF(current_setting('app.user_id', true),'')::uuid
--   app.current_user_is_school_admin()      -> boolean ORG_ADMIN/SUPER_ADMIN in the current school
--   app.current_user_teacher_id()           -> uuid    the caller's teacher id, or NULL
--   app.teaches_class(class_id)             -> boolean lead teacher or timetable-slot teacher
--   app.is_related_to_student(student_id)   -> boolean caller is the student, or a linked parent
--   app.is_privileged_over_student(sid)     -> boolean admin, or teacher of an enrolled class
--   app.can_read_student(student_id)        -> boolean privileged OR related
--   app.can_read_class(class_id)            -> boolean admin, teacher, enrolled student, or parent of one
--   app.teaches_gradebook / _exam / _assignment(id) -> boolean teacher of the record's class
--   app.can_read_grade(grade_submission_id) -> boolean grade row via its submission (release-gated)
--   app.can_read_course / _subject(id)      -> boolean referenced by a readable class

CREATE POLICY role_scope_visibility ON app.students
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(id));

CREATE POLICY role_scope_visibility ON app.enrollments
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    app.current_user_is_school_admin()
    OR app.teaches_class(class_id)
    OR app.is_related_to_student(student_id)
  );

CREATE POLICY role_scope_visibility ON app.classes
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_class(id));

CREATE POLICY role_scope_visibility ON app.subjects
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_subject(id));

CREATE POLICY role_scope_visibility ON app.courses
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_course(id));

CREATE POLICY role_scope_visibility ON app.materials
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_class(class_id));

CREATE POLICY role_scope_visibility ON app.assignments
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_class(class_id));

CREATE POLICY role_scope_visibility ON app.exams
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_class(class_id));

CREATE POLICY role_scope_visibility ON app.gradebooks
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_class(class_id));

CREATE POLICY role_scope_visibility ON app.timetable_slots
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_class(class_id));

-- Student's own submission is theirs in any grading status; teacher of the class and admins also see it.
CREATE POLICY role_scope_visibility ON app.assignment_submissions
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    app.current_user_is_school_admin()
    OR app.teaches_assignment(assignment_id)
    OR app.is_related_to_student(student_id)
  );

-- Release gate: staff see any status; self/parent see published results only.
CREATE POLICY role_scope_visibility ON app.exam_results
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    app.current_user_is_school_admin()
    OR app.teaches_exam(exam_id)
    OR (status = 'published' AND app.is_related_to_student(student_id))
  );

CREATE POLICY role_scope_visibility ON app.grade_submissions
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    app.current_user_is_school_admin()
    OR app.teaches_gradebook(gradebook_id)
    OR (status = 'published' AND app.is_related_to_student(student_id))
  );

CREATE POLICY role_scope_visibility ON app.grades
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_grade(grade_submission_id));

-- Partitioned attendance: installed on the parent and on every leaf (RLS does not cascade, and
-- studafy_app can name a partition directly). app.create_attendance_partitions installs it on future
-- leaves. Sessions scope by class; records scope by student.
CREATE POLICY role_scope_visibility ON app.attendance_sessions
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_class(class_id));

CREATE POLICY role_scope_visibility ON app.attendance_records
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(student_id));
