-- Creates the school-owned grades workflow: gradebooks scoped to a class, per-student
-- grade_submissions with a draft→submitted→approved/rejected→published state machine, and
-- individual grade records (score, max, weight). The trigger enforces valid transitions and
-- auto-writes audit timestamps; CHECK constraints pin nullable columns to status as
-- defense-in-depth. Grades visibility is derived from the submission's published state,
-- not stored redundantly. See docs/database/grades-workflow.md for the full design note.

SET ROLE studafy_admin;

CREATE TYPE app.gradebook_status AS ENUM ('draft', 'active', 'archived');
CREATE TYPE app.grade_submission_status AS ENUM (
  'draft', 'submitted', 'approved', 'rejected', 'published'
);

CREATE TABLE app.gradebooks (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_gradebooks PRIMARY KEY,
  school_id uuid NOT NULL,
  class_id uuid NOT NULL,
  status app.gradebook_status NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_gradebooks_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_gradebooks_school_class UNIQUE (school_id, class_id),
  CONSTRAINT fk_gradebooks_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_gradebooks_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_gradebooks_status CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT ck_gradebooks_timestamps CHECK (updated_at >= created_at)
);

-- One grade submission per student per gradebook. The state machine controls whether the
-- student's grades are visible: only 'published' submissions expose their grades to
-- students and parents. Timestamps and actor IDs are written by the transition trigger,
-- never accepted verbatim from client input.
CREATE TABLE app.grade_submissions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grade_submissions PRIMARY KEY,
  school_id uuid NOT NULL,
  gradebook_id uuid NOT NULL,
  student_id uuid NOT NULL,
  submitted_by_user_id uuid,
  decided_by_user_id uuid,
  status app.grade_submission_status NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_grade_submissions_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_grade_submissions_school_gradebook_student
    UNIQUE (school_id, gradebook_id, student_id),
  CONSTRAINT fk_grade_submissions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_submissions_gradebook FOREIGN KEY (gradebook_id, school_id)
    REFERENCES app.gradebooks (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_submissions_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_submissions_submitted_by FOREIGN KEY (submitted_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_submissions_decided_by FOREIGN KEY (decided_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_grade_submissions_lifecycle CHECK (
    (
      status = 'draft'
      AND submitted_at IS NULL AND submitted_by_user_id IS NULL
      AND decided_at IS NULL AND decided_by_user_id IS NULL
    ) OR (
      status = 'submitted'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND decided_at IS NULL AND decided_by_user_id IS NULL
    ) OR (
      status IN ('approved', 'rejected', 'published')
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
      AND decided_at >= submitted_at
    )
  ),
  CONSTRAINT ck_grade_submissions_timestamps CHECK (updated_at >= created_at)
);

-- Individual grade records. Standalone by design: no FK to assignments or exams, keeping the
-- grading workflow decoupled from the assessment tables. score is nullable (NULL means
-- ungraded); max_score and weight are always positive. label is a human-readable identifier
-- for the graded item (e.g. "Midterm", "Homework 3").
CREATE TABLE app.grades (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grades PRIMARY KEY,
  school_id uuid NOT NULL,
  grade_submission_id uuid NOT NULL,
  score numeric(10, 2),
  max_score numeric(10, 2) NOT NULL,
  weight numeric(10, 2) NOT NULL DEFAULT 1,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_grades_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_grades_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grades_grade_submission FOREIGN KEY (grade_submission_id, school_id)
    REFERENCES app.grade_submissions (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_grades_score CHECK (score IS NULL OR score >= 0),
  CONSTRAINT ck_grades_max_score CHECK (max_score > 0),
  CONSTRAINT ck_grades_weight CHECK (weight > 0),
  CONSTRAINT ck_grades_score_not_exceed_max CHECK (score IS NULL OR score <= max_score),
  CONSTRAINT ck_grades_label CHECK (label = btrim(label) AND label <> ''),
  CONSTRAINT ck_grades_timestamps CHECK (updated_at >= created_at)
);

-- Enforces the grade_submissions approval state machine. Valid transitions:
--   draft → submitted, submitted → approved, submitted → rejected,
--   approved → published, rejected → draft (resubmission cycle).
-- Audit timestamps and actor IDs are written here, from the session's own values,
-- never accepted verbatim from an update that skips a state.
CREATE FUNCTION app.enforce_grade_submission_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a new grade submission must start in draft status, got %', NEW.status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id THEN
      RAISE EXCEPTION
        'submission/decision audit columns can only change together with a status transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    IF NEW.submitted_by_user_id IS NULL THEN
      RAISE EXCEPTION 'submitting grades requires submitted_by_user_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := CURRENT_TIMESTAMP;
    NEW.decided_at := NULL;
    NEW.decided_by_user_id := NULL;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
    IF NEW.decided_by_user_id IS NULL THEN
      RAISE EXCEPTION 'approving grade submission requires decided_by_user_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by_user_id := OLD.submitted_by_user_id;
    NEW.decided_at := CURRENT_TIMESTAMP;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'rejected' THEN
    IF NEW.decided_by_user_id IS NULL THEN
      RAISE EXCEPTION 'rejecting grade submission requires decided_by_user_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by_user_id := OLD.submitted_by_user_id;
    NEW.decided_at := CURRENT_TIMESTAMP;
  ELSIF OLD.status = 'approved' AND NEW.status = 'published' THEN
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by_user_id := OLD.submitted_by_user_id;
    NEW.decided_at := OLD.decided_at;
    NEW.decided_by_user_id := OLD.decided_by_user_id;
  ELSIF OLD.status = 'rejected' AND NEW.status = 'draft' THEN
    NEW.submitted_at := NULL;
    NEW.submitted_by_user_id := NULL;
    NEW.decided_at := NULL;
    NEW.decided_by_user_id := NULL;
  ELSE
    RAISE EXCEPTION 'invalid grade submission transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_grade_submissions_transition
BEFORE INSERT OR UPDATE OF
  status, submitted_at, submitted_by_user_id, decided_at, decided_by_user_id
ON app.grade_submissions
FOR EACH ROW EXECUTE FUNCTION app.enforce_grade_submission_transition();

ALTER FUNCTION app.enforce_grade_submission_transition() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.enforce_grade_submission_transition() FROM PUBLIC, studafy_app;

-- One gradebook per class (a class is already scoped to one term and academic year, so a
-- unique school_id + class_id pair implicitly enforces one gradebook per class-per-term).
CREATE INDEX idx_gradebooks_school_class_id
  ON app.gradebooks (school_id, class_id, id);

-- Submission lookups: by gradebook (all students in a class), by student (all classes),
-- by status for the pending-approval queue, and by submission actor for audit.
CREATE INDEX idx_grade_submissions_school_gradebook_id
  ON app.grade_submissions (school_id, gradebook_id, id);
CREATE INDEX idx_grade_submissions_school_student_id
  ON app.grade_submissions (school_id, student_id, id);
CREATE INDEX idx_grade_submissions_school_status_submitted_at
  ON app.grade_submissions (school_id, status, submitted_at, id);

-- Grade lookups: by submission (all grades for one student in one gradebook). The submission
-- FK back-index is covered by the composite unique + FK structure, but this explicit index
-- serves the primary "render one submission's grades" query.
CREATE INDEX idx_grades_school_grade_submission_id
  ON app.grades (school_id, grade_submission_id, id);

REVOKE ALL PRIVILEGES ON TABLE app.gradebooks, app.grade_submissions, app.grades FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.gradebooks, app.grade_submissions, app.grades TO studafy_app;

REVOKE ALL ON TYPE app.gradebook_status, app.grade_submission_status FROM PUBLIC;
GRANT USAGE ON TYPE app.gradebook_status, app.grade_submission_status TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'gradebooks');
SELECT app.apply_tenant_isolation('app', 'grade_submissions');
SELECT app.apply_tenant_isolation('app', 'grades');

RESET ROLE;
