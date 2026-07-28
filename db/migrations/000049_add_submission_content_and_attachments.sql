-- ST-104: submission content, lateness, attempt tracking, grade release state, and the file
-- attachments a student hands in with their work.
--
-- app.assignment_submissions has existed since 000011, but it could not express four facts the
-- submissions API is built on:
--
--   1. WHAT THE STUDENT WROTE. There was no content column at all -- the table recorded that a
--      hand-in happened and how it was marked, but not the hand-in.
--   2. THAT A HAND-IN WAS LATE, ONCE IT HAS BEEN MARKED. 000011 modelled lateness as the enum
--      value 'late', and ck_assignment_submissions_lifecycle made that mutually exclusive with
--      'graded'. Marking a late submission therefore erased the fact that it was late. is_late
--      below is a plain boolean, orthogonal to the lifecycle, and grading does not clear it.
--   3. A MARKED BUT UNRELEASED GRADE. The old constraint allowed a score only when
--      status = 'graded', so there was nowhere to keep a teacher's draft marking. grade_status
--      adds that second axis.
--   4. THAT A SUBMISSION REPLACED AN EARLIER ONE. Resubmission updates the row in place (the
--      uq_assignment_submissions_school_assignment_student unique constraint permits nothing
--      else), so without attempt_number every attempt looked like the first.
--
-- WHY THERE IS NO BACKFILL UPDATE IN THIS FILE.
-- app.apply_tenant_isolation (000006) issues FORCE ROW LEVEL SECURITY and a policy declared
-- TO PUBLIC, so studafy_admin is subject to it too, and a migration session carries exactly one
-- app.school_id. A cross-tenant UPDATE is therefore not expressible here at all -- it would
-- silently touch at most one school. The two columns that need a computed per-row value are
-- introduced as STORED generated columns and immediately demoted to plain columns with
-- DROP EXPRESSION: the computation runs during DDL, the data is retained, and no row policy is
-- ever consulted. DROP EXPRESSION is PostgreSQL 13+; this stack is 16 (db/compose.yml).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- Grade release state
-- ---------------------------------------------------------------------------

-- Three values rather than a boolean, because "not marked yet" and "marked but withheld" are
-- different facts and only the second one carries a score the student must not see.
-- app.exam_result_status (000011) draws the same distinction with 'graded' vs 'published'; this
-- is that idea narrowed to the two states a submission actually needs.
CREATE TYPE app.submission_grade_status AS ENUM ('none', 'draft', 'published');

REVOKE ALL ON TYPE app.submission_grade_status FROM PUBLIC;
GRANT USAGE ON TYPE app.submission_grade_status TO studafy_app;

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------

ALTER TABLE app.assignment_submissions
  ADD COLUMN content text,
  ADD COLUMN attempt_number integer NOT NULL DEFAULT 1;

-- Generated-then-demoted so pre-existing 'late' rows keep their meaning. A constant DEFAULT false
-- would quietly downgrade every historical late hand-in to on-time.
ALTER TABLE app.assignment_submissions
  ADD COLUMN is_late boolean NOT NULL
    GENERATED ALWAYS AS (status = 'late') STORED;
ALTER TABLE app.assignment_submissions ALTER COLUMN is_late DROP EXPRESSION;
ALTER TABLE app.assignment_submissions ALTER COLUMN is_late SET DEFAULT false;

-- Same technique, and here it is load-bearing rather than tidy: the lifecycle constraint below
-- requires status = 'graded' to imply grade_status = 'published'. A constant DEFAULT 'none' would
-- put every already-graded row in violation, and ADD CONSTRAINT validates existing rows.
ALTER TABLE app.assignment_submissions
  ADD COLUMN grade_status app.submission_grade_status NOT NULL
    GENERATED ALWAYS AS (
      CASE
        WHEN status = 'graded' THEN 'published'::app.submission_grade_status
        ELSE 'none'::app.submission_grade_status
      END
    ) STORED;
ALTER TABLE app.assignment_submissions ALTER COLUMN grade_status DROP EXPRESSION;
ALTER TABLE app.assignment_submissions ALTER COLUMN grade_status SET DEFAULT 'none';

-- ---------------------------------------------------------------------------
-- Rewritten lifecycle constraint
-- ---------------------------------------------------------------------------

-- Replacing rather than amending, following 000046's precedent for the timetable state machine:
-- the clauses are mutually exclusive by construction and are far easier to read as one list than
-- as an original plus a series of patches.
ALTER TABLE app.assignment_submissions
  DROP CONSTRAINT ck_assignment_submissions_lifecycle;

ALTER TABLE app.assignment_submissions
  ADD CONSTRAINT ck_assignment_submissions_lifecycle CHECK (
    -- Nothing handed in, so nothing a marker could have produced.
    (status = 'draft'
      AND submitted_at IS NULL
      AND grade_status = 'none'
      AND graded_at IS NULL AND graded_by_user_id IS NULL
      AND score IS NULL AND feedback IS NULL)

    -- Handed in, untouched by a marker.
    --
    -- 'late' stays admissible because rows written before is_late existed carry it and this file
    -- cannot rewrite them (see the header). The application never writes it again: it writes
    -- 'submitted' with is_late = true.
    OR (status IN ('submitted', 'late', 'returned')
      AND submitted_at IS NOT NULL
      AND grade_status = 'none'
      AND graded_at IS NULL AND graded_by_user_id IS NULL
      AND score IS NULL AND feedback IS NULL)

    -- Handed in, MARKED BUT NOT RELEASED. This is the case the old constraint could not express
    -- and the reason this migration exists: the teacher's score and feedback sit on the row while
    -- the student's view of that same row still reads 'submitted'. Because status does not move,
    -- the student needs no separate signal suppressed -- the withholding is a projection concern
    -- (apps/api/src/modules/academics/submissions/routes/submission-routes.ts) and not a second
    -- lifecycle state they could observe.
    --
    -- score and feedback are each optional here so a marker can save comments before settling on a
    -- number, or the reverse. What is required is that somebody marked it, at some time.
    OR (status IN ('submitted', 'late', 'returned')
      AND submitted_at IS NOT NULL
      AND grade_status = 'draft'
      AND graded_at IS NOT NULL AND graded_by_user_id IS NOT NULL)

    -- Released. status = 'graded' and grade_status = 'published' are one fact recorded twice, and
    -- this clause is what stops the two from ever disagreeing.
    OR (status = 'graded'
      AND submitted_at IS NOT NULL
      AND grade_status = 'published'
      AND graded_at IS NOT NULL AND graded_by_user_id IS NOT NULL
      AND score IS NOT NULL)

    OR (status = 'withdrawn'
      AND grade_status = 'none'
      AND graded_at IS NULL AND graded_by_user_id IS NULL
      AND score IS NULL AND feedback IS NULL)
  );

-- Lateness is orthogonal to the lifecycle but not to reality: a submission that was never handed
-- in cannot be late. Kept as its own constraint precisely so the clauses above stay silent about
-- is_late, which is what lets a grade land without disturbing it.
ALTER TABLE app.assignment_submissions
  ADD CONSTRAINT ck_assignment_submissions_late_requires_submission CHECK (
    is_late = false OR submitted_at IS NOT NULL
  );

ALTER TABLE app.assignment_submissions
  ADD CONSTRAINT ck_assignment_submissions_attempt_number CHECK (attempt_number >= 1);

ALTER TABLE app.assignment_submissions
  ADD CONSTRAINT ck_assignment_submissions_content CHECK (
    content IS NULL OR (content = btrim(content) AND content <> '')
  );

-- ---------------------------------------------------------------------------
-- Indexes: deliberately none on app.assignment_submissions
-- ---------------------------------------------------------------------------
--
-- grade_status gets no index of its own, and the reason is worth recording because adding one is
-- the obvious move.
--
-- Every query in the submissions module leads with (school_id, assignment_id), which
-- uq_assignment_submissions_school_assignment_student (000011) already serves as a btree prefix.
-- That prefix narrows to a single assignment's class roster -- tens of rows -- so filtering
-- grade_status on top of it is free. An index adding grade_status after those two columns would
-- buy no measurable selectivity while costing write amplification on a table this hot.
--
-- It would also do active harm. An index on (school_id, assignment_id, grade_status, id) does not
-- contain student_id, so for the exact three-column lookup
-- (school_id = ? AND assignment_id = ? AND student_id = ?) it can only match the two-column prefix
-- and then filter. On a small table its cost ties with the unique index that matches all three,
-- and the planner picks between them arbitrarily -- displacing the correct index for the most
-- common lookup in the module. packages/db/tests/assessment-content.test.ts pins that choice, and
-- caught exactly this.

-- ---------------------------------------------------------------------------
-- Submission attachments
-- ---------------------------------------------------------------------------

-- Modelled column-for-column on app.assignment_attachments (000047), which is itself modelled on
-- app.materials (000011). Same reasoning as that file gives: this is the schema's existing "a row
-- that points at a stored object" shape, and a second convention for the same thing would cost
-- more than the repetition does.
--
-- THE STORAGE KEY CHECK IS A TENANT BOUNDARY, NOT A FORMAT CHECK.
-- ck_submission_attachments_storage_key pins the key to '^permanent/<this row's school_id>/...'.
-- The application performs the same check before it calls the storage service
-- (apps/api/src/lib/storage/keys.ts); this is the half that still holds if that code is bypassed
-- or wrong. The app check stops an object being copied into another school's prefix; this one
-- stops a row claiming an object there.
CREATE TABLE app.submission_attachments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_submission_attachments PRIMARY KEY,
  school_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  uploaded_by_user_id uuid NOT NULL,
  storage_key text NOT NULL,
  original_file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  checksum_sha256 text,
  -- Which attempt this file belongs to. Resubmission updates the submission row in place rather
  -- than inserting a new one (ST-104), so without this every attempt's files would collapse into
  -- one undifferentiated pile and a teacher could not tell which version they were marking.
  attempt_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_submission_attachments_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_submission_attachments_storage_key UNIQUE (storage_key),
  CONSTRAINT fk_submission_attachments_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- CASCADE for the reason 000047 gives: an attachment has no meaning apart from the row it hangs
  -- off. Note the direction -- app.assignment_submissions still references app.assignments
  -- ON DELETE RESTRICT, so this opens no path to destroying student work by deleting an
  -- assignment. deleteAssignment archives instead when submissions exist.
  CONSTRAINT fk_submission_attachments_submission FOREIGN KEY (submission_id, school_id)
    REFERENCES app.assignment_submissions (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_submission_attachments_uploaded_by FOREIGN KEY (uploaded_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_submission_attachments_storage_key CHECK (
    storage_key = btrim(storage_key)
    AND storage_key ~ ('^permanent/' || school_id::text || '/[^/]+/[^/]+$')
  ),
  CONSTRAINT ck_submission_attachments_original_file_name CHECK (
    original_file_name = btrim(original_file_name) AND original_file_name <> ''
    AND original_file_name !~ '[/\\]'
  ),
  CONSTRAINT ck_submission_attachments_mime_type CHECK (
    mime_type = btrim(mime_type) AND mime_type ~ '^[^/[:space:]]+/[^/[:space:]]+$'
  ),
  CONSTRAINT ck_submission_attachments_size CHECK (size_bytes > 0),
  CONSTRAINT ck_submission_attachments_checksum CHECK (
    checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_submission_attachments_attempt_number CHECK (attempt_number >= 1),
  CONSTRAINT ck_submission_attachments_timestamps CHECK (updated_at >= created_at)
);

-- Tenant-leading, matching every other index in this schema so it stays usable under
-- school_id = current_setting('app.school_id')::uuid. Serves the batched hydration the list
-- endpoint performs (one query for a page of submissions, not one per submission), and orders by
-- attempt so the current attempt's files group together.
CREATE INDEX idx_submission_attachments_school_submission
  ON app.submission_attachments (school_id, submission_id, attempt_number, created_at, id);

CREATE INDEX idx_submission_attachments_school_uploaded_by
  ON app.submission_attachments (school_id, uploaded_by_user_id, id);

REVOKE ALL PRIVILEGES ON TABLE app.submission_attachments FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.submission_attachments TO studafy_app;

-- Applies BOTH the permissive tenant_isolation policy and the school_id immutability trigger:
-- 000025 rewrapped this function to do the two together, so a single call is the whole boundary.
SELECT app.apply_tenant_isolation('app', 'submission_attachments');

-- ---------------------------------------------------------------------------
-- Role scope (extends 000037)
-- ---------------------------------------------------------------------------

-- Deliberately the same predicate 000037 put on app.assignment_submissions itself, so an
-- attachment is exactly as visible as the submission it belongs to: the student who wrote it, a
-- linked parent, the teacher of the assignment's class, or a school admin. One rule, written once,
-- called from two places.
--
-- Note what it does NOT do: there is no grade_status predicate here. Unlike app.exam_results,
-- which 000037 gates wholesale on publication, a submission is the student's own work and must
-- stay readable while it is being marked -- hiding the row would make their own hand-in vanish
-- from their view. Withholding an unreleased grade is a COLUMN-level rule, and a column rule
-- cannot live in a row policy; it lives in the response projection. See
-- apps/api/src/modules/academics/submissions/routes/submission-routes.ts.
--
-- SECURITY DEFINER for the reason 000037's header sets out at length: this is called from a
-- RESTRICTIVE policy and itself reads app.assignment_submissions, which carries its own
-- restrictive policy. A SECURITY INVOKER lookup would re-enter that policy and recurse. Owned by
-- studafy_admin, so its reads run with only the permissive tenant_isolation policy in force --
-- still school-scoped, because the predicate pins school_id to the app.school_id GUC.
CREATE FUNCTION app.can_read_submission(target_submission_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.assignment_submissions AS s
    WHERE s.id = target_submission_id
      AND s.school_id = current_setting('app.school_id')::uuid
      AND (
        app.current_user_is_school_admin()
        OR app.teaches_assignment(s.assignment_id)
        OR app.is_related_to_student(s.student_id)
      )
  )
$function$;

-- Grants mirror 000037's block for the helpers it defines: revoked from PUBLIC, executable by the
-- runtime role, which evaluates it from inside the policy expression below. Ownership is already
-- studafy_admin by virtue of the SET ROLE at the top of this file.
REVOKE ALL ON FUNCTION app.can_read_submission(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_submission(uuid) TO studafy_app;

CREATE POLICY role_scope_visibility ON app.submission_attachments
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_submission(submission_id));

RESET ROLE;
