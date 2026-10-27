-- A school's seat change request can also ask for a different tier per audience
-- (docs/billing/feature-licensing.md, session 5): "move our students to Student Pro".
--
--   * student_plan_id, teacher_plan_id, parent_plan_id -- the tier wanted for that audience, or NULL
--     for "no change". A request is still a request: nothing changes on the license until the super
--     admin prices it as a quote and the school accepts.
--
-- Each tier must be a tier of its own audience: a cross-table rule, so a trigger, as for
-- app.school_licenses (000163). The plans are global rows (no school key), like the license's own
-- tier columns, and are not indexed for the same reason: a plan is never deleted (RESTRICT), so the
-- foreign keys are only checked on insert.
--
-- The table's grants and tenant isolation (000163) cover the new columns.
--
-- app.license_change_requests has forced RLS. The new columns are nullable, so every existing row
-- satisfies the foreign keys; a non-matching tenant context lets the validation scan run without
-- weakening RLS or leaving the constraints NOT VALID (the same approach as 000053 and 000147).
SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

ALTER TABLE app.license_change_requests
  ADD COLUMN student_plan_id uuid,
  ADD COLUMN teacher_plan_id uuid,
  ADD COLUMN parent_plan_id uuid,
  ADD CONSTRAINT fk_license_change_requests_student_plan FOREIGN KEY (student_plan_id)
    REFERENCES app.plans (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_license_change_requests_teacher_plan FOREIGN KEY (teacher_plan_id)
    REFERENCES app.plans (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_license_change_requests_parent_plan FOREIGN KEY (parent_plan_id)
    REFERENCES app.plans (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE FUNCTION app.license_change_requests_check_tiers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  slot record;
BEGIN
  FOR slot IN
    SELECT * FROM (VALUES
      ('student', NEW.student_plan_id),
      ('teacher', NEW.teacher_plan_id),
      ('parent', NEW.parent_plan_id)
    ) AS t (audience, plan_id)
    WHERE t.plan_id IS NOT NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM app.plans AS p WHERE p.id = slot.plan_id AND p.audience = slot.audience
    ) THEN
      RAISE EXCEPTION 'plan % is not a % tier', slot.plan_id, slot.audience
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_change_requests_tier_audience',
              TABLE = 'license_change_requests', SCHEMA = 'app';
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_license_change_requests_check_tiers
  BEFORE INSERT OR UPDATE OF student_plan_id, teacher_plan_id, parent_plan_id
  ON app.license_change_requests
  FOR EACH ROW EXECUTE FUNCTION app.license_change_requests_check_tiers();

REVOKE ALL ON FUNCTION app.license_change_requests_check_tiers() FROM PUBLIC;

COMMENT ON COLUMN app.license_change_requests.student_plan_id IS
  'The student tier the school asks for, or NULL for no change.';
COMMENT ON COLUMN app.license_change_requests.teacher_plan_id IS
  'The teacher tier the school asks for, or NULL for no change.';
COMMENT ON COLUMN app.license_change_requests.parent_plan_id IS
  'The parent (Family+) tier the school asks for, or NULL for no change.';

RESET ROLE;
