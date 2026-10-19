-- School-wide attendance visibility for ATTENDANCE_OFFICER (role added in 000132).
--
-- An attendance officer takes and corrects attendance for any class in the school, so they must see
-- every class, its roster and its attendance -- but nothing else a class carries. That rules out the
-- shortcut 000120 took for PRINCIPAL (adding the role to app.current_user_is_school_admin()): that
-- function is the admin escape hatch of every role-scope policy and is also called by the API to
-- reserve leadership actions (grade approvals, out-of-window attendance overrides). It also rules out
-- widening app.can_read_class / app.can_read_student, whose other callers are materials, assignments,
-- exams, gradebooks and progress reports -- tables whose read routes are guarded by RLS alone.
--
-- Instead each policy an attendance taker needs is re-pointed at a helper that ORs the officer in:
--
--   students, attendance_records (+ leaves), attendance_record_versions -> can_read_student_for_attendance
--   classes, timetable_slots, attendance_sessions (+ leaves)             -> can_read_class_for_attendance
--   enrollments, courses, subjects                                        -> existing predicate OR officer
--
-- Every other policy is untouched, so an officer still reads no grades, exams, materials,
-- assignments, discipline or evaluations. ALTER POLICY keeps each policy's name, role, command and
-- RESTRICTIVE-ness; only USING changes. app.create_attendance_partitions is amended so future monthly
-- leaves get the same predicates (000037's discipline).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- Helpers. SECURITY DEFINER owned by studafy_admin, like every 000037 helper, so their lookups see
-- only tenant_isolation and never recurse into the restrictive policies they serve.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.current_user_is_attendance_officer()
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
      AND ur.role = 'ATTENDANCE_OFFICER'
  )
$function$;

CREATE FUNCTION app.can_read_class_for_attendance(target_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.can_read_class(target_class_id) OR app.current_user_is_attendance_officer()
$function$;

CREATE FUNCTION app.can_read_student_for_attendance(target_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.can_read_student(target_student_id) OR app.current_user_is_attendance_officer()
$function$;

REVOKE ALL ON FUNCTION
  app.current_user_is_attendance_officer(),
  app.can_read_class_for_attendance(uuid),
  app.can_read_student_for_attendance(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.current_user_is_attendance_officer(),
  app.can_read_class_for_attendance(uuid),
  app.can_read_student_for_attendance(uuid)
TO studafy_app;

-- ---------------------------------------------------------------------------
-- Roster and timetable: who is in a class, and when it meets.
-- ---------------------------------------------------------------------------

ALTER POLICY role_scope_visibility ON app.students
  USING (app.can_read_student_for_attendance(id));

ALTER POLICY role_scope_visibility ON app.classes
  USING (app.can_read_class_for_attendance(id));

ALTER POLICY role_scope_visibility ON app.timetable_slots
  USING (app.can_read_class_for_attendance(class_id));

ALTER POLICY role_scope_visibility ON app.enrollments
  USING (
    app.current_user_is_school_admin()
    OR app.teaches_class(class_id)
    OR app.is_related_to_student(student_id)
    OR app.current_user_is_attendance_officer()
  );

-- Course and subject names label each class in the officer's class picker.
ALTER POLICY role_scope_visibility ON app.courses
  USING (app.can_read_course(id) OR app.current_user_is_attendance_officer());

ALTER POLICY role_scope_visibility ON app.subjects
  USING (app.can_read_subject(id) OR app.current_user_is_attendance_officer());

-- ---------------------------------------------------------------------------
-- Attendance itself: sessions, records (parents and every existing monthly leaf) and correction
-- history.
-- ---------------------------------------------------------------------------

ALTER POLICY role_scope_visibility ON app.attendance_sessions
  USING (app.can_read_class_for_attendance(class_id));

ALTER POLICY role_scope_visibility ON app.attendance_records
  USING (app.can_read_student_for_attendance(student_id));

ALTER POLICY role_scope_visibility ON app.attendance_record_versions
  USING (app.can_read_student_for_attendance(student_id));

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
        'ALTER POLICY role_scope_visibility ON app.%I '
        'USING (app.can_read_class_for_attendance(class_id))',
        leaf.name
      );
    ELSE
      EXECUTE pg_catalog.format(
        'ALTER POLICY role_scope_visibility ON app.%I '
        'USING (app.can_read_student_for_attendance(student_id))',
        leaf.name
      );
    END IF;
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------------
-- Future monthly leaves. Body identical to 000037's version except the two role_scope_visibility
-- predicates, which now name the attendance helpers above.
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
    -- ST-085 + 000133: a session partition scopes by class, a record partition by student, each with
    -- the attendance officer's school-wide arm.
    IF parent = 'attendance_sessions' THEN
      EXECUTE pg_catalog.format(
        'CREATE POLICY role_scope_visibility ON app.%I '
        'AS RESTRICTIVE FOR SELECT TO studafy_app USING (app.can_read_class_for_attendance(class_id))',
        partition_name
      );
    ELSE
      EXECUTE pg_catalog.format(
        'CREATE POLICY role_scope_visibility ON app.%I '
        'AS RESTRICTIVE FOR SELECT TO studafy_app USING (app.can_read_student_for_attendance(student_id))',
        partition_name
      );
    END IF;

    created := created || partition_name;
  END LOOP;

  RETURN created;
END
$function$;

RESET ROLE;
