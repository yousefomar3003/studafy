-- Staff and class records (docs/modules/student-records.md "Staff and class records", ADR-019).
--
-- 000170 built school-defined records for students and parents; 000175 added the 'staff' and
-- 'class' subject kinds. This wires them into the same tables -- templates, fields, versions and
-- documents need nothing new, since they are keyed by subject kind or hang off an answer:
--
-- 1. app.record_answers gains staff_user_id (a user holding a staff role; the application checks the
--    role, as it checks PARENT for parent_user_id) and class_id, each cascading like the existing
--    subject columns: an answer means nothing without the person or class it is about. subject_id
--    is regenerated to cover them (PostgreSQL 16 cannot alter a generated expression in place, so
--    the column and the unique key built on it are dropped and recreated), and the per-subject
--    CHECK is rewritten so exactly the kind's own column is set.
-- 2. The RESTRICTIVE SELECT role_scope_visibility policy gains the two kinds. A staff member's
--    answers are leadership's (app.current_user_is_school_admin: ORG_ADMIN, PRINCIPAL) and the staff
--    member's own; a class's are leadership's and its teachers' (app.teaches_class, 000037). Which
--    fields within that each reader sees -- never a sensitive one except ORG_ADMIN's -- is the
--    application's, as for students and parents. Documents follow their answer's policy (000170).
-- 3. app.users.archived_at -- when an account was archived, maintained by the database like
--    app.students.left_at, so the sensitive-record retention sweep can count a staff member's
--    sensitive answers (a national ID, a salary) from when they left.
--
-- Nothing is matched or linked on an answer: the subject columns are the only link, and they are
-- set by staff choosing the person or class, never from a value.

-- app.record_answers already has forced RLS. Its new subject columns are nullable and empty, so every
-- existing row satisfies the new foreign keys; a non-matching tenant context lets the validation
-- scan run without weakening RLS or leaving the constraints NOT VALID (as 000147 and 000168 do).
SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- 1 -------------------------------------------------------------------------------------------------

ALTER TABLE app.record_answers
  ADD COLUMN staff_user_id uuid,
  ADD COLUMN class_id uuid,
  ADD CONSTRAINT fk_record_answers_staff_user FOREIGN KEY (staff_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT fk_record_answers_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE app.record_answers DROP CONSTRAINT uq_record_answers_subject_field;
ALTER TABLE app.record_answers DROP COLUMN subject_id;
ALTER TABLE app.record_answers
  ADD COLUMN subject_id uuid
    GENERATED ALWAYS AS (coalesce(student_id, parent_user_id, staff_user_id, class_id)) STORED;
ALTER TABLE app.record_answers
  ADD CONSTRAINT uq_record_answers_subject_field
    UNIQUE (school_id, subject_kind, subject_id, field_id);

ALTER TABLE app.record_answers DROP CONSTRAINT ck_record_answers_subject;
ALTER TABLE app.record_answers ADD CONSTRAINT ck_record_answers_subject CHECK (
  num_nonnulls(student_id, parent_user_id, staff_user_id, class_id) = 1
  AND CASE subject_kind
    WHEN 'student' THEN student_id IS NOT NULL
    WHEN 'parent' THEN parent_user_id IS NOT NULL
    WHEN 'staff' THEN staff_user_id IS NOT NULL
    WHEN 'class' THEN class_id IS NOT NULL
    ELSE false
  END
);

CREATE INDEX ix_record_answers_school_staff_user
  ON app.record_answers (school_id, staff_user_id) WHERE staff_user_id IS NOT NULL;
CREATE INDEX ix_record_answers_school_class
  ON app.record_answers (school_id, class_id) WHERE class_id IS NOT NULL;

-- 2 -------------------------------------------------------------------------------------------------

DROP POLICY role_scope_visibility ON app.record_answers;

CREATE POLICY role_scope_visibility ON app.record_answers
  AS RESTRICTIVE
  FOR SELECT
  TO studafy_app
  USING (
    CASE subject_kind
      WHEN 'student' THEN app.can_read_student(student_id)
      WHEN 'parent' THEN app.current_user_is_school_admin()
      WHEN 'staff' THEN
        app.current_user_is_school_admin() OR staff_user_id = app.scope_user_id()
      WHEN 'class' THEN
        app.current_user_is_school_admin() OR app.teaches_class(class_id)
      ELSE false
    END
  );

-- 3 -------------------------------------------------------------------------------------------------

ALTER TABLE app.users ADD COLUMN archived_at timestamptz;

-- Set when an account moves to 'archived', cleared when it comes back; every path that changes a
-- user's status (the API, the closure sweep, an erasure) keeps it.
CREATE FUNCTION app.set_user_archived_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.status = 'archived' THEN
    IF TG_OP = 'INSERT' OR OLD.status <> 'archived' THEN
      NEW.archived_at := coalesce(NEW.archived_at, CURRENT_TIMESTAMP);
    END IF;
  ELSE
    NEW.archived_at := NULL;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app.set_user_archived_at() FROM PUBLIC;

CREATE TRIGGER trg_users_archived_at
  BEFORE INSERT OR UPDATE OF status ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.set_user_archived_at();

-- Backfill accounts already archived: the last update is the best record of when. Forced RLS
-- applies to the owner too, so this walks one tenant at a time (as 000170 does).
DO $backfill$
DECLARE
  tenant_id uuid;
BEGIN
  FOR tenant_id IN SELECT id FROM app.schools LOOP
    PERFORM pg_catalog.set_config('app.school_id', tenant_id::text, true);
    UPDATE app.users
       SET archived_at = updated_at
     WHERE school_id = tenant_id
       AND status = 'archived'
       AND archived_at IS NULL;
  END LOOP;
END
$backfill$;

RESET ROLE;
