-- ST-085: intra-tenant row scope for teachers, parents, and students.
--
-- Tenant isolation (000006) answers "which school?". This migration adds the second question RLS must
-- answer for the academic tables: "which rows within the school may THIS user see?". It layers a
-- RESTRICTIVE SELECT policy named role_scope_visibility onto each academic table. Restrictive policies
-- AND with the permissive tenant_isolation policy, so a row is readable only when both agree: the
-- school matches app.school_id (outer boundary) and the caller's role/relationship grants access to
-- the row (inner boundary). This is the same shape already used by evaluation_visibility (000014) and
-- notification_user_isolation (000017).
--
-- WHY ONE POLICY PER TABLE WITH ORed SCOPES, NOT THREE.
-- PostgreSQL ANDs restrictive policies together. Three separate policies (teacher / parent / student)
-- would demand a caller satisfy all three at once, which no one can. The scopes must therefore be ORed
-- inside a single policy, with an admin escape hatch, exactly like teacher_evaluation_visibility's
-- "teacher OR evaluator".
--
-- WHY THE HELPERS ARE SECURITY DEFINER AND THE POLICIES ARE "TO studafy_app".
-- The scope predicates read relationship tables (classes, enrollments, parent_child_links, ...), and
-- several of those tables ALSO receive a role_scope_visibility policy here. A SECURITY INVOKER lookup
-- would re-trigger those policies and recurse. Instead every helper is SECURITY DEFINER owned by
-- studafy_admin, so its lookups run as studafy_admin; and every policy is declared TO studafy_app, so
-- it never applies to studafy_admin. Inside a helper only the permissive tenant_isolation policy
-- (TO PUBLIC) is in force -- correctly scoping the lookup to the current school -- while the new
-- restrictive policies are skipped, breaking the recursion. Ownership immutability and FORCE RLS are
-- unaffected: the helpers still cannot cross a school boundary because every lookup pins
-- school_id = current_setting('app.school_id')::uuid and tenant_isolation enforces the same.
--
-- SCOPE OF THIS MIGRATION.
-- SELECT only. Write authorization stays with tenant_isolation's WITH CHECK plus the application
-- permission matrix; per-role write scoping is a separate follow-up. Roles are read from the database
-- (app.user_roles, app.parent_child_links), never from a client-supplied claim.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------------

-- The authenticated user, or NULL when no user context is set. Unlike app.current_user_id() (000014),
-- which raises on a missing app.user_id, this reads it with missing_ok = true and maps an unset or
-- empty value to NULL. app.user_id is legitimately absent in some tenant transactions (account
-- activation sets only school_id + request_id), and a scope predicate that raised there would turn a
-- benign userless read into an error. Mapping to NULL keeps those predicates fail-closed: every
-- equality below against a NULL user id is NULL (never true), so a userless caller sees no scoped rows.
CREATE FUNCTION app.scope_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$function$;

-- True when the current user holds an administrative role in the current school. Admins keep full,
-- school-wide read access to every academic table -- the escape hatch ORed into every policy below.
CREATE FUNCTION app.current_user_is_school_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.user_roles AS ur
    WHERE ur.school_id = current_setting('app.school_id')::uuid
      AND ur.user_id = app.scope_user_id()
      AND ur.role IN ('ORG_ADMIN', 'SUPER_ADMIN')
  )
$function$;

-- The current user's teacher id in the current school, or NULL when they are not a teacher.
CREATE FUNCTION app.current_user_teacher_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT t.id
  FROM app.teachers AS t
  WHERE t.school_id = current_setting('app.school_id')::uuid
    AND t.user_id = app.scope_user_id()
$function$;

-- ---------------------------------------------------------------------------
-- Relationship predicates
-- ---------------------------------------------------------------------------

-- True when the current user teaches the class: they are its lead teacher, or they hold at least one
-- timetable slot for it (substitute / co-teacher). Purely a teacher check -- students and parents are
-- never "teaching" a class.
CREATE FUNCTION app.teaches_class(target_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_teacher_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM app.classes AS c
        WHERE c.id = target_class_id
          AND c.school_id = current_setting('app.school_id')::uuid
          AND c.lead_teacher_id = app.current_user_teacher_id()
      )
      OR EXISTS (
        SELECT 1
        FROM app.timetable_slots AS ts
        WHERE ts.class_id = target_class_id
          AND ts.school_id = current_setting('app.school_id')::uuid
          AND ts.teacher_id = app.current_user_teacher_id()
      )
    )
$function$;

-- True when the current user IS the student (their own user_id) or is a linked parent/guardian of the
-- student. This is the "self or parent" half of student visibility; it deliberately excludes teachers
-- so that the published-only gate on grades and exam results can distinguish it from staff access.
CREATE FUNCTION app.is_related_to_student(target_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.students AS s
    WHERE s.id = target_student_id
      AND s.school_id = current_setting('app.school_id')::uuid
      AND s.user_id = app.scope_user_id()
  )
  OR EXISTS (
    SELECT 1
    FROM app.parent_child_links AS pcl
    WHERE pcl.student_id = target_student_id
      AND pcl.school_id = current_setting('app.school_id')::uuid
      AND pcl.parent_user_id = app.scope_user_id()
  )
$function$;

-- True when the current user is staff with authority over the student's records: a school admin, or a
-- teacher of at least one class the student is enrolled in. Teachers/admins see the student's grades
-- and exam results in any status; "related" callers (self/parent) do not (see the gated policies).
CREATE FUNCTION app.is_privileged_over_student(target_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR (
      app.current_user_teacher_id() IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM app.enrollments AS e
        WHERE e.student_id = target_student_id
          AND e.school_id = current_setting('app.school_id')::uuid
          AND app.teaches_class(e.class_id)
      )
    )
$function$;

-- Ungated student visibility: admin OR teacher-of-an-enrolled-class OR self/parent. Used by the
-- student profile, enrollment (self/parent branch), and student-scoped record tables that carry no
-- release gate (attendance, assignment submissions).
CREATE FUNCTION app.can_read_student(target_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.is_privileged_over_student(target_student_id)
      OR app.is_related_to_student(target_student_id)
$function$;

-- Class visibility: admin OR a teacher of the class OR a student enrolled in it OR a parent whose
-- linked child is enrolled in it. Drives every class-owned resource (classes, materials, assignments,
-- exams, gradebooks, timetable slots, attendance sessions).
CREATE FUNCTION app.can_read_class(target_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR app.teaches_class(target_class_id)
    OR EXISTS (
      -- the current user is a student enrolled in the class
      SELECT 1
      FROM app.enrollments AS e
      JOIN app.students AS s ON s.id = e.student_id AND s.school_id = e.school_id
      WHERE e.class_id = target_class_id
        AND e.school_id = current_setting('app.school_id')::uuid
        AND s.user_id = app.scope_user_id()
    )
    OR EXISTS (
      -- a child linked to the current user is enrolled in the class
      SELECT 1
      FROM app.enrollments AS e
      JOIN app.parent_child_links AS pcl
        ON pcl.student_id = e.student_id AND pcl.school_id = e.school_id
      WHERE e.class_id = target_class_id
        AND e.school_id = current_setting('app.school_id')::uuid
        AND pcl.parent_user_id = app.scope_user_id()
    )
$function$;

-- ---------------------------------------------------------------------------
-- Class-resolving teacher predicates for grade/exam/assignment records
-- ---------------------------------------------------------------------------
-- Each resolves the owning class of a record and asks teaches_class about it, so a teacher's access to
-- a student's grades/results/submissions is scoped to the class they actually teach -- not to every
-- class a shared student happens to be in.

CREATE FUNCTION app.teaches_gradebook(target_gradebook_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.gradebooks AS gb
    WHERE gb.id = target_gradebook_id
      AND gb.school_id = current_setting('app.school_id')::uuid
      AND app.teaches_class(gb.class_id)
  )
$function$;

CREATE FUNCTION app.teaches_exam(target_exam_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.exams AS ex
    WHERE ex.id = target_exam_id
      AND ex.school_id = current_setting('app.school_id')::uuid
      AND app.teaches_class(ex.class_id)
  )
$function$;

CREATE FUNCTION app.teaches_assignment(target_assignment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.assignments AS a
    WHERE a.id = target_assignment_id
      AND a.school_id = current_setting('app.school_id')::uuid
      AND app.teaches_class(a.class_id)
  )
$function$;

-- Grade-record visibility, resolved through the grade submission: staff (admin or the gradebook's
-- teacher) see grades in any workflow status; self/parent see them only once the submission is
-- published. Mirrors the grade_submissions policy below, one level of indirection deeper.
CREATE FUNCTION app.can_read_grade(target_grade_submission_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.grade_submissions AS gs
    WHERE gs.id = target_grade_submission_id
      AND gs.school_id = current_setting('app.school_id')::uuid
      AND (
        app.current_user_is_school_admin()
        OR app.teaches_gradebook(gs.gradebook_id)
        OR (gs.status = 'published' AND app.is_related_to_student(gs.student_id))
      )
  )
$function$;

-- ---------------------------------------------------------------------------
-- Catalog visibility (subjects / courses)
-- ---------------------------------------------------------------------------
-- A subject or course is visible when the caller can read at least one class that delivers it, so a
-- teacher/student/parent sees only the parts of the catalog their classes touch, not the whole school
-- catalog. Admin sees all.

CREATE FUNCTION app.can_read_course(target_course_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR EXISTS (
      SELECT 1
      FROM app.classes AS c
      WHERE c.course_id = target_course_id
        AND c.school_id = current_setting('app.school_id')::uuid
        AND app.can_read_class(c.id)
    )
$function$;

CREATE FUNCTION app.can_read_subject(target_subject_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR EXISTS (
      SELECT 1
      FROM app.courses AS co
      JOIN app.classes AS c ON c.course_id = co.id AND c.school_id = co.school_id
      WHERE co.subject_id = target_subject_id
        AND co.school_id = current_setting('app.school_id')::uuid
        AND app.can_read_class(c.id)
    )
$function$;

-- ---------------------------------------------------------------------------
-- Grants: the runtime role evaluates these from within policy expressions.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  app.scope_user_id(),
  app.current_user_is_school_admin(),
  app.current_user_teacher_id(),
  app.teaches_class(uuid),
  app.is_related_to_student(uuid),
  app.is_privileged_over_student(uuid),
  app.can_read_student(uuid),
  app.can_read_class(uuid),
  app.teaches_gradebook(uuid),
  app.teaches_exam(uuid),
  app.teaches_assignment(uuid),
  app.can_read_grade(uuid),
  app.can_read_course(uuid),
  app.can_read_subject(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.scope_user_id(),
  app.current_user_is_school_admin(),
  app.current_user_teacher_id(),
  app.teaches_class(uuid),
  app.is_related_to_student(uuid),
  app.is_privileged_over_student(uuid),
  app.can_read_student(uuid),
  app.can_read_class(uuid),
  app.teaches_gradebook(uuid),
  app.teaches_exam(uuid),
  app.teaches_assignment(uuid),
  app.can_read_grade(uuid),
  app.can_read_course(uuid),
  app.can_read_subject(uuid)
TO studafy_app;

-- ---------------------------------------------------------------------------
-- Restrictive SELECT policies. All AS RESTRICTIVE ... TO studafy_app so they AND with tenant_isolation
-- and never apply to the studafy_admin-owned SECURITY DEFINER helpers above.
-- ---------------------------------------------------------------------------

-- Students, enrollments, catalog, and class-owned resources -----------------

CREATE POLICY role_scope_visibility ON app.students
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(id));

-- Teacher sees their class's roster; self/parent see only their own enrollment rows (not classmates').
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

-- Student-owned records -----------------------------------------------------

-- A student's own submission is theirs regardless of grading status; the teacher of the assignment's
-- class and admins see it too. No release gate here (a submission is not a released grade).
CREATE POLICY role_scope_visibility ON app.assignment_submissions
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    app.current_user_is_school_admin()
    OR app.teaches_assignment(assignment_id)
    OR app.is_related_to_student(student_id)
  );

-- Released-grade gate: staff see any status; self/parent see published results only.
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

-- Attendance (partitioned) --------------------------------------------------
-- RLS does not cascade from a partitioned parent to its partitions, and studafy_app can name a
-- partition directly, so the policy is installed on the parent AND on every existing leaf here, and on
-- every future leaf by the amended app.create_attendance_partitions below (same discipline as
-- tenant_isolation in 000012).

CREATE POLICY role_scope_visibility ON app.attendance_sessions
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_class(class_id));

CREATE POLICY role_scope_visibility ON app.attendance_records
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(student_id));

DO $do$
DECLARE
  leaf record;
BEGIN
  FOR leaf IN
    SELECT child.relname AS name, parent.relname AS parent_name
    FROM pg_catalog.pg_inherits AS inh
    JOIN pg_catalog.pg_class AS child ON child.oid = inh.inhrelid
    JOIN pg_catalog.pg_class AS parent ON parent.oid = inh.inhparent
    JOIN pg_catalog.pg_namespace AS n ON n.oid = parent.relnamespace
    WHERE n.nspname = 'app'
      AND parent.relname IN ('attendance_sessions', 'attendance_records')
  LOOP
    IF leaf.parent_name = 'attendance_sessions' THEN
      EXECUTE pg_catalog.format(
        'CREATE POLICY role_scope_visibility ON app.%I '
        'AS RESTRICTIVE FOR SELECT TO studafy_app USING (app.can_read_class(class_id))',
        leaf.name
      );
    ELSE
      EXECUTE pg_catalog.format(
        'CREATE POLICY role_scope_visibility ON app.%I '
        'AS RESTRICTIVE FOR SELECT TO studafy_app USING (app.can_read_student(student_id))',
        leaf.name
      );
    END IF;
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------------
-- Forward amendment of app.create_attendance_partitions (000012) so every future monthly partition is
-- created with the role_scope_visibility policy alongside tenant_isolation. The body is identical to
-- 000012 except for the two CREATE POLICY lines added after apply_tenant_isolation; without them a new
-- month's partition would be a row-scope hole for direct-partition reads.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.create_attendance_partitions(target_month date)
RETURNS text[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET timezone = 'UTC'
AS $function$
DECLARE
  month_start timestamptz;
  month_end timestamptz;
  parent text;
  partition_name text;
  created text[] := ARRAY[]::text[];
  existing_oid oid;
  existing_kind "char";
  existing_parent oid;
  existing_bounds text;
  expected_bounds text;
BEGIN
  IF target_month IS NULL THEN
    RAISE EXCEPTION 'target month must not be null' USING ERRCODE = '22023';
  END IF;

  month_start := pg_catalog.date_trunc('month', target_month::timestamptz);
  month_end := month_start + INTERVAL '1 month';
  expected_bounds := pg_catalog.format('FOR VALUES FROM (%L) TO (%L)', month_start, month_end);

  FOREACH parent IN ARRAY ARRAY['attendance_sessions', 'attendance_records'] LOOP
    partition_name := pg_catalog.format(
      '%s_y%sm%s',
      parent,
      pg_catalog.to_char(month_start, 'YYYY'),
      pg_catalog.to_char(month_start, 'MM')
    );

    SELECT c.oid, c.relkind, i.inhparent
    INTO existing_oid, existing_kind, existing_parent
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_inherits AS i ON i.inhrelid = c.oid
    WHERE n.nspname = 'app' AND c.relname = partition_name;

    IF existing_oid IS NOT NULL THEN
      IF existing_kind <> 'r'
         OR existing_parent IS DISTINCT FROM pg_catalog.to_regclass('app.' || pg_catalog.quote_ident(parent))::oid THEN
        RAISE EXCEPTION 'app.% already exists and is not a partition of app.%',
          partition_name, parent
          USING ERRCODE = '42P07';
      END IF;

      SELECT pg_catalog.pg_get_expr(c.relpartbound, c.oid)
      INTO existing_bounds
      FROM pg_catalog.pg_class AS c
      WHERE c.oid = existing_oid;

      IF pg_catalog.regexp_replace(existing_bounds, '[[:space:]]', '', 'g')
         <> pg_catalog.regexp_replace(expected_bounds, '[[:space:]]', '', 'g') THEN
        RAISE EXCEPTION
          'existing partition app.% has bounds % but % were requested; refusing to alter it',
          partition_name, existing_bounds, expected_bounds
          USING ERRCODE = '42P17';
      END IF;

      CONTINUE;
    END IF;

    EXECUTE pg_catalog.format(
      'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
      partition_name, parent, month_start, month_end
    );
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE app.%I FROM PUBLIC', partition_name);
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.%I TO studafy_app',
      partition_name
    );
    PERFORM app.apply_tenant_isolation('app', partition_name);
    -- ST-085: the leaf inherits the tenant boundary above and its intra-tenant row scope here. A
    -- session partition scopes by class; a record partition scopes by student.
    IF parent = 'attendance_sessions' THEN
      EXECUTE pg_catalog.format(
        'CREATE POLICY role_scope_visibility ON app.%I '
        'AS RESTRICTIVE FOR SELECT TO studafy_app USING (app.can_read_class(class_id))',
        partition_name
      );
    ELSE
      EXECUTE pg_catalog.format(
        'CREATE POLICY role_scope_visibility ON app.%I '
        'AS RESTRICTIVE FOR SELECT TO studafy_app USING (app.can_read_student(student_id))',
        partition_name
      );
    END IF;

    created := created || partition_name;
  END LOOP;

  RETURN created;
END
$function$;

RESET ROLE;
