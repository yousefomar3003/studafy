-- ST-116: published-grade read model, course credits, publication timestamps, and indexes.
--
-- Publication remains normalized on grade_submissions. Individual grade rows deliberately do not
-- duplicate student, class, term, or lifecycle columns; the read path joins through the owning
-- submission and gradebook.

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

-- Course credits are the weighting unit for term and cumulative GPA.
ALTER TABLE app.courses
  ADD COLUMN credit_hours numeric(6,2) NOT NULL DEFAULT 1;

ALTER TABLE app.courses
  ADD CONSTRAINT ck_courses_credit_hours CHECK (credit_hours > 0);

-- A distinct publication timestamp is required because decided_at records the administrative
-- decision, while publication is the visibility transition.
ALTER TABLE app.grade_submissions
  ADD COLUMN published_at timestamptz;

UPDATE app.grade_submissions
SET published_at = updated_at
WHERE status = 'published' AND published_at IS NULL;

ALTER TABLE app.grade_submissions
  DROP CONSTRAINT ck_grade_submissions_lifecycle;

ALTER TABLE app.grade_submissions
  ADD CONSTRAINT ck_grade_submissions_lifecycle CHECK (
    (
      status = 'draft'
      AND submitted_at IS NULL AND submitted_by_user_id IS NULL
      AND decided_at IS NULL AND decided_by_user_id IS NULL
      AND rejection_reason IS NULL AND published_at IS NULL
    ) OR (
      status = 'submitted'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND decided_at IS NULL AND decided_by_user_id IS NULL
      AND rejection_reason IS NULL AND published_at IS NULL
    ) OR (
      status = 'approved'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
      AND decided_at >= submitted_at
      AND rejection_reason IS NULL AND published_at IS NULL
    ) OR (
      status = 'rejected'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
      AND decided_at >= submitted_at
      AND rejection_reason IS NOT NULL AND published_at IS NULL
    ) OR (
      status = 'published'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
      AND decided_at >= submitted_at
      AND rejection_reason IS NULL AND published_at IS NOT NULL
      AND published_at >= decided_at
    )
  );

CREATE OR REPLACE FUNCTION app.enforce_grade_submission_transition()
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
    NEW.published_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
       OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
       OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION
        'submission/decision/publication audit columns can only change with a status transition'
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
    NEW.rejection_reason := NULL;
    NEW.published_at := NULL;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
    IF NEW.decided_by_user_id IS NULL THEN
      RAISE EXCEPTION 'approving grade submission requires decided_by_user_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by_user_id := OLD.submitted_by_user_id;
    NEW.decided_at := CURRENT_TIMESTAMP;
    NEW.rejection_reason := NULL;
    NEW.published_at := NULL;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'rejected' THEN
    IF NEW.decided_by_user_id IS NULL THEN
      RAISE EXCEPTION 'rejecting grade submission requires decided_by_user_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by_user_id := OLD.submitted_by_user_id;
    NEW.decided_at := CURRENT_TIMESTAMP;
    NEW.published_at := NULL;
  ELSIF OLD.status = 'approved' AND NEW.status = 'published' THEN
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by_user_id := OLD.submitted_by_user_id;
    NEW.decided_at := OLD.decided_at;
    NEW.decided_by_user_id := OLD.decided_by_user_id;
    NEW.rejection_reason := NULL;
    NEW.published_at := CURRENT_TIMESTAMP;
  ELSIF OLD.status = 'rejected' AND NEW.status = 'draft' THEN
    NEW.submitted_at := NULL;
    NEW.submitted_by_user_id := NULL;
    NEW.decided_at := NULL;
    NEW.decided_by_user_id := NULL;
    NEW.rejection_reason := NULL;
    NEW.published_at := NULL;
  ELSE
    RAISE EXCEPTION 'invalid grade submission transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION app.enforce_grade_submission_transition() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.enforce_grade_submission_transition() FROM PUBLIC, studafy_app;

CREATE TABLE app.student_term_summaries (
  id                      uuid DEFAULT gen_random_uuid()
                          CONSTRAINT pk_student_term_summaries PRIMARY KEY,
  school_id               uuid NOT NULL,
  student_id              uuid NOT NULL,
  academic_term_id        uuid NOT NULL,
  academic_year_id        uuid NOT NULL,
  term_gpa                numeric(7,2),
  term_average_percentage numeric(7,2),
  total_credits           numeric(8,2) NOT NULL DEFAULT 0,
  calculated_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_student_term_summaries_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_student_term_summaries_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_term_summaries_student
    FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_student_term_summaries_term
    FOREIGN KEY (academic_term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_term_summaries_gpa
    CHECK (term_gpa IS NULL OR term_gpa >= 0),
  CONSTRAINT ck_student_term_summaries_average
    CHECK (
      term_average_percentage IS NULL
      OR (term_average_percentage >= 0 AND term_average_percentage <= 100)
    ),
  CONSTRAINT ck_student_term_summaries_credits CHECK (total_credits >= 0)
);

CREATE UNIQUE INDEX idx_student_term_summaries
  ON app.student_term_summaries (school_id, student_id, academic_term_id);

CREATE INDEX idx_grade_submissions_published_lookup
  ON app.grade_submissions (school_id, student_id, status, published_at DESC)
  WHERE status = 'published';

CREATE INDEX idx_grade_submissions_gradebook_published
  ON app.grade_submissions (school_id, gradebook_id, student_id, published_at DESC)
  WHERE status = 'published';

-- studafy_app is named explicitly, not just PUBLIC: 000002 sets ALTER DEFAULT PRIVILEGES granting it
-- full DML on every table studafy_admin creates in app, so revoking from PUBLIC alone would leave
-- INSERT/UPDATE/DELETE in place and silently contradict the SELECT-only grant below. That matters
-- more here than on an ordinary table: tenant_isolation is the only policy that gates writes
-- (role_scope_visibility below is FOR SELECT), so it checks school_id and nothing else. With the DML
-- default privileges left in place, any request context could write a summary row for any student in
-- its own tenant -- and the read path serves term_gpa straight from this table, so a student could
-- forge their own GPA. Writes go through app.upsert_student_term_summary only.
REVOKE ALL PRIVILEGES ON TABLE app.student_term_summaries FROM PUBLIC, studafy_app;
GRANT SELECT ON TABLE app.student_term_summaries TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'student_term_summaries');

CREATE POLICY role_scope_visibility ON app.student_term_summaries
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.is_related_to_student(student_id));

-- Runtime callers may read only their own/linked summaries. Publication writes through this narrow
-- tenant-checked seam so an administrator deciding a submission does not need SELECT visibility over
-- the student's materialized result.
CREATE FUNCTION app.upsert_student_term_summary(
  target_school_id uuid,
  target_student_id uuid,
  target_term_id uuid,
  target_academic_year_id uuid,
  target_term_gpa numeric,
  target_term_average_percentage numeric,
  target_total_credits numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF target_school_id IS DISTINCT FROM current_setting('app.school_id')::uuid THEN
    RAISE EXCEPTION 'student term summary school does not match the active tenant'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO app.student_term_summaries (
    school_id,
    student_id,
    academic_term_id,
    academic_year_id,
    term_gpa,
    term_average_percentage,
    total_credits,
    calculated_at
  )
  VALUES (
    target_school_id,
    target_student_id,
    target_term_id,
    target_academic_year_id,
    target_term_gpa,
    target_term_average_percentage,
    target_total_credits,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (school_id, student_id, academic_term_id) DO UPDATE
  SET academic_year_id = EXCLUDED.academic_year_id,
      term_gpa = EXCLUDED.term_gpa,
      term_average_percentage = EXCLUDED.term_average_percentage,
      total_credits = EXCLUDED.total_credits,
      calculated_at = EXCLUDED.calculated_at;
END
$function$;

ALTER FUNCTION app.upsert_student_term_summary(uuid, uuid, uuid, uuid, numeric, numeric, numeric)
  OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.upsert_student_term_summary(
  uuid, uuid, uuid, uuid, numeric, numeric, numeric
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.upsert_student_term_summary(
  uuid, uuid, uuid, uuid, numeric, numeric, numeric
) TO studafy_app;

-- Backfill materialized summaries for already-published rows. Gradebooks without a persisted
-- scheme still receive percentage/credit summaries; their GPA remains null and will use the
-- application-layer school-default formatter on reads.
DO $backfill$
DECLARE
  target_school_id uuid;
BEGIN
  FOR target_school_id IN SELECT id FROM app.schools LOOP
    PERFORM set_config('app.school_id', target_school_id::text, true);

WITH class_scores AS (
  SELECT
    gs.school_id,
    gs.student_id,
    c.term_id,
    c.academic_year_id,
    c.id AS class_id,
    co.credit_hours,
    COALESCE(
      gb.grading_scheme_id,
      (
        SELECT scheme.id
        FROM app.grading_schemes AS scheme
        WHERE scheme.school_id = gs.school_id
          AND scheme.term_id = c.term_id
        ORDER BY scheme.version DESC
        LIMIT 1
      )
    ) AS grading_scheme_id,
    (
      SUM((g.score / g.max_score) * g.weight)
        FILTER (WHERE g.score IS NOT NULL)
      / NULLIF(SUM(g.weight) FILTER (WHERE g.score IS NOT NULL), 0)
    ) * 100 AS class_percentage
  FROM app.grade_submissions AS gs
  JOIN app.gradebooks AS gb
    ON gb.id = gs.gradebook_id AND gb.school_id = gs.school_id
  JOIN app.classes AS c
    ON c.id = gb.class_id AND c.school_id = gs.school_id
  JOIN app.courses AS co
    ON co.id = c.course_id AND co.school_id = gs.school_id
  JOIN app.grades AS g
    ON g.grade_submission_id = gs.id AND g.school_id = gs.school_id
  WHERE gs.school_id = target_school_id
    AND gs.status = 'published'
  GROUP BY
    gs.school_id, gs.student_id, c.term_id, c.academic_year_id,
    c.id, co.credit_hours, gb.grading_scheme_id
),
scored_classes AS (
  SELECT
    score.*,
    boundary.gpa_points
  FROM class_scores AS score
  LEFT JOIN LATERAL (
    SELECT b.gpa_points
    FROM app.grading_scheme_boundaries AS b
    WHERE b.school_id = score.school_id
      AND b.grading_scheme_id = score.grading_scheme_id
      AND score.class_percentage >= b.min_percentage
    ORDER BY b.min_percentage DESC, b.position ASC
    LIMIT 1
  ) AS boundary ON true
  WHERE score.class_percentage IS NOT NULL
),
term_scores AS (
  SELECT
    school_id,
    student_id,
    term_id,
    academic_year_id,
    ROUND(
      SUM(class_percentage * credit_hours) / NULLIF(SUM(credit_hours), 0),
      2
    ) AS term_average_percentage,
    CASE
      WHEN BOOL_AND(gpa_points IS NOT NULL) THEN ROUND(
        SUM(gpa_points * credit_hours) / NULLIF(SUM(credit_hours), 0),
        2
      )
      ELSE NULL
    END AS term_gpa,
    SUM(credit_hours) AS total_credits
  FROM scored_classes
  GROUP BY school_id, student_id, term_id, academic_year_id
)
INSERT INTO app.student_term_summaries (
  school_id,
  student_id,
  academic_term_id,
  academic_year_id,
  term_gpa,
  term_average_percentage,
  total_credits,
  calculated_at
)
SELECT
  school_id,
  student_id,
  term_id,
  academic_year_id,
  term_gpa,
  term_average_percentage,
  total_credits,
  CURRENT_TIMESTAMP
FROM term_scores
ON CONFLICT (school_id, student_id, academic_term_id) DO UPDATE
SET academic_year_id = EXCLUDED.academic_year_id,
    term_gpa = EXCLUDED.term_gpa,
    term_average_percentage = EXCLUDED.term_average_percentage,
    total_credits = EXCLUDED.total_credits,
    calculated_at = EXCLUDED.calculated_at;
  END LOOP;
END
$backfill$;

RESET ROLE;
