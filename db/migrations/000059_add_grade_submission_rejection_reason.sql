SET ROLE studafy_admin;

ALTER TABLE app.grade_submissions ADD COLUMN rejection_reason text;

ALTER TABLE app.grade_submissions
  DROP CONSTRAINT ck_grade_submissions_lifecycle;

ALTER TABLE app.grade_submissions
  ADD CONSTRAINT ck_grade_submissions_lifecycle CHECK (
    (
      status = 'draft'
      AND submitted_at IS NULL AND submitted_by_user_id IS NULL
      AND decided_at IS NULL AND decided_by_user_id IS NULL
      AND rejection_reason IS NULL
    ) OR (
      status = 'submitted'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND decided_at IS NULL AND decided_by_user_id IS NULL
      AND rejection_reason IS NULL
    ) OR (
      status IN ('approved', 'published')
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
      AND decided_at >= submitted_at
      AND rejection_reason IS NULL
    ) OR (
      status = 'rejected'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
      AND decided_at >= submitted_at
      AND rejection_reason IS NOT NULL
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
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
       OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason THEN
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
    NEW.rejection_reason := NULL;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
    IF NEW.decided_by_user_id IS NULL THEN
      RAISE EXCEPTION 'approving grade submission requires decided_by_user_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by_user_id := OLD.submitted_by_user_id;
    NEW.decided_at := CURRENT_TIMESTAMP;
    NEW.rejection_reason := NULL;
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
    NEW.rejection_reason := NULL;
  ELSIF OLD.status = 'rejected' AND NEW.status = 'draft' THEN
    NEW.submitted_at := NULL;
    NEW.submitted_by_user_id := NULL;
    NEW.decided_at := NULL;
    NEW.decided_by_user_id := NULL;
    NEW.rejection_reason := NULL;
  ELSE
    RAISE EXCEPTION 'invalid grade submission transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION app.enforce_grade_submission_transition() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.enforce_grade_submission_transition() FROM PUBLIC, studafy_app;

RESET ROLE;
