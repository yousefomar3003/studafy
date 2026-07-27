-- Adds rejected_reason to timetable_versions so principals can explain why a timetable
-- submission is sent back to draft. The column is nullable: it is NULL for fresh drafts and
-- approved versions, and set only on the pending → draft transition. Re-submission (draft →
-- pending) clears it so a stale reason never lingers.

ALTER TABLE app.timetable_versions ADD COLUMN rejected_reason text;

-- Replace the CHECK constraint so it permits rejected_reason only in the draft state.
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
      status = 'approved'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL
      AND approved_at >= submitted_at
      AND rejected_reason IS NULL
    )
  );

-- Replace the state-transition trigger to manage rejected_reason:
--   INSERT: no change (column defaults to NULL, CHECK enforces invariant)
--   draft → pending: clear rejected_reason
--   pending → approved: leave rejected_reason as NULL (CHECK enforces)
--   pending → draft: leave NEW.rejected_reason as-is (the UPDATE sets it)
--   same status: reject tampering with rejected_reason (same pattern as other audit columns)
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
