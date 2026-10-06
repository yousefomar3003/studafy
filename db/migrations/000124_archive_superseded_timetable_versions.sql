-- Allow a live timetable version to be archived when a newer version of its term is approved
-- (000123 added the 'archived' enum value). Archived versions keep their submission/approval
-- stamps, are read-only (enforce_timetable_slot_version_editable already rejects slot changes on
-- any non-draft version), and are a terminal state.

SET ROLE studafy_admin;

ALTER TABLE app.timetable_versions
  DROP CONSTRAINT ck_timetable_versions_submission_state;

ALTER TABLE app.timetable_versions
  ADD CONSTRAINT ck_timetable_versions_submission_state CHECK (
    (
      status = 'draft'
      AND submitted_at IS NULL AND submitted_by_user_id IS NULL
      AND approved_at IS NULL AND approved_by_user_id IS NULL
    ) OR (
      status = 'pending'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND approved_at IS NULL AND approved_by_user_id IS NULL
      AND rejected_reason IS NULL
    ) OR (
      status IN ('approved', 'archived')
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL
      AND approved_at >= submitted_at
      AND rejected_reason IS NULL
    )
  );

-- Same function as 000046, plus the approved → archived transition.
CREATE OR REPLACE FUNCTION app.enforce_timetable_version_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a new timetable version must start in draft status, got %', NEW.status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.rejected_reason IS DISTINCT FROM OLD.rejected_reason THEN
      RAISE EXCEPTION
        'submission/approval audit columns can only change together with a status transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'pending' THEN
    IF NEW.submitted_by_user_id IS NULL THEN
      RAISE EXCEPTION 'submitting a timetable version requires submitted_by_user_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := CURRENT_TIMESTAMP;
    NEW.approved_at := NULL;
    NEW.approved_by_user_id := NULL;
    NEW.rejected_reason := NULL;
  ELSIF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    IF NEW.approved_by_user_id IS NULL THEN
      RAISE EXCEPTION 'approving a timetable version requires approved_by_user_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by_user_id := OLD.submitted_by_user_id;
    NEW.approved_at := CURRENT_TIMESTAMP;
    NEW.rejected_reason := NULL;
  ELSIF OLD.status = 'approved' AND NEW.status = 'archived' THEN
    -- Superseded by a newer approved version: the submission/approval stamps are history and
    -- stay exactly as they were.
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by_user_id := OLD.submitted_by_user_id;
    NEW.approved_at := OLD.approved_at;
    NEW.approved_by_user_id := OLD.approved_by_user_id;
    NEW.rejected_reason := NULL;
  ELSIF OLD.status = 'pending' AND NEW.status = 'draft' THEN
    NEW.submitted_at := NULL;
    NEW.submitted_by_user_id := NULL;
    NEW.approved_at := NULL;
    NEW.approved_by_user_id := NULL;
    -- rejected_reason is left as-is: the UPDATE sets it from the application layer.
  ELSE
    RAISE EXCEPTION 'invalid timetable version transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION app.enforce_timetable_version_transition() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.enforce_timetable_version_transition() FROM PUBLIC, studafy_app;

RESET ROLE;
