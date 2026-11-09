-- Platform roles live only in platform schools (QA-10, finding F-01, docs/security/findings-register.md).
--
-- SUPER_ADMIN and SUPPORT_AGENT work for Studafy, not for a school, yet app.user_roles accepted them
-- in any school. Together with an API that let an ORG_ADMIN assign any role, that let a school admin
-- make themselves SUPER_ADMIN and reach /api/platform/* across every school. The API now refuses
-- platform roles at the school endpoints (users/schemas.ts ASSIGNABLE_ROLES); this is the database
-- floor under it, so even a raw studafy_app write cannot escalate.
--
-- 1. app.schools.is_platform_tenant -- the schools that hold Studafy's own staff. Global table, no
--    RLS, like is_review_tenant / is_qa_tenant.
-- 2. Only studafy_admin (or a role that is a member of it) may set or clear the flag. studafy_app has
--    table-level INSERT/UPDATE on app.schools for registration (000035), so without this guard it
--    could flag its own school and then pass check 3. SECURITY INVOKER on purpose: the check is on
--    who is writing.
-- 3. app.user_roles: a platform role is accepted only in a flagged school. SECURITY DEFINER so it can
--    read the flag whoever inserts the role; it reads nothing tenant-scoped.
-- 4. The review tenant (000116) is reachable with a shared password, so it is never a platform
--    school.
--
-- Backfill: every school that already holds a platform role is flagged, so existing platform staff
-- keep working and the migration cannot fail on live data. The flagged schools are listed as
-- NOTICEs; on staging and production check that list against the real platform school -- any other
-- school on it holds a platform role that should be removed (F-01 may have been exploited there).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

ALTER TABLE app.schools
  ADD COLUMN is_platform_tenant boolean NOT NULL DEFAULT false;

ALTER TABLE app.schools
  ADD CONSTRAINT ck_schools_platform_tenant_not_review_tenant CHECK (
    NOT (is_platform_tenant AND is_review_tenant)
  );

COMMENT ON COLUMN app.schools.is_platform_tenant IS
  'True for the schools that hold Studafy staff. Only these may hold SUPER_ADMIN or SUPPORT_AGENT. Set by studafy_admin only.';

CREATE FUNCTION app.schools_guard_platform_tenant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.is_platform_tenant)
    OR (TG_OP = 'UPDATE' AND NEW.is_platform_tenant IS DISTINCT FROM OLD.is_platform_tenant)
  THEN
    IF NOT pg_has_role(current_user, 'studafy_admin', 'MEMBER') THEN
      RAISE EXCEPTION 'only studafy_admin may change schools.is_platform_tenant'
        USING ERRCODE = 'insufficient_privilege', TABLE = 'schools', SCHEMA = 'app';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_schools_guard_platform_tenant
  BEFORE INSERT OR UPDATE OF is_platform_tenant
  ON app.schools
  FOR EACH ROW EXECUTE FUNCTION app.schools_guard_platform_tenant();

REVOKE ALL ON FUNCTION app.schools_guard_platform_tenant() FROM PUBLIC;

CREATE FUNCTION app.user_roles_check_platform_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.role IN ('SUPER_ADMIN', 'SUPPORT_AGENT') AND NOT EXISTS (
    SELECT 1 FROM app.schools AS s WHERE s.id = NEW.school_id AND s.is_platform_tenant
  ) THEN
    RAISE EXCEPTION 'platform role % can only be held in a platform school', NEW.role
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_user_roles_platform_role_school',
            TABLE = 'user_roles', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_user_roles_check_platform_role
  BEFORE INSERT OR UPDATE OF role, school_id
  ON app.user_roles
  FOR EACH ROW EXECUTE FUNCTION app.user_roles_check_platform_role();

REVOKE ALL ON FUNCTION app.user_roles_check_platform_role() FROM PUBLIC;

-- Per-school loop: tenant_isolation is FORCED on app.user_roles, so one statement under the sentinel
-- context would see no rows (000065, 000069, 000172).
DO $backfill$
DECLARE
  target record;
BEGIN
  FOR target IN SELECT id, slug FROM app.schools ORDER BY slug LOOP
    PERFORM set_config('app.school_id', target.id::text, true);

    IF EXISTS (
      SELECT 1 FROM app.user_roles WHERE role IN ('SUPER_ADMIN', 'SUPPORT_AGENT')
    ) THEN
      UPDATE app.schools SET is_platform_tenant = true WHERE id = target.id;
      RAISE NOTICE 'flagged % (%) as a platform school: it already holds a platform role',
        target.slug, target.id;
    END IF;
  END LOOP;

  PERFORM set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
END
$backfill$;

RESET ROLE;
