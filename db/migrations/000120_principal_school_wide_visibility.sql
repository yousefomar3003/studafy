-- Give PRINCIPAL the same school-wide read visibility as ORG_ADMIN across the academic tables.
--
-- app.current_user_is_school_admin() (000037) is the admin escape hatch ORed into every role-scope
-- RLS policy -- students, enrollments, classes, attendance, grades and the rest (see
-- db/policies/role_scope_visibility.sql) -- and is also called directly by the API where an action
-- is reserved to school leadership (grade approvals, attendance corrections outside a teacher's own
-- classes). A principal oversees the whole school, so without this they would see empty attendance
-- reports and approval queues. What a principal may *do* is still bounded by PRINCIPAL_PERMISSIONS
-- in packages/constants/src/permissions.ts; this only widens which rows they can see.
--
-- CREATE OR REPLACE keeps the function's owner and its EXECUTE grants from 000037. Runs in its own
-- migration, after 000119, because PostgreSQL forbids using an enum value in the transaction that
-- added it.

SET ROLE studafy_admin;

CREATE OR REPLACE FUNCTION app.current_user_is_school_admin()
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
      AND ur.role IN ('ORG_ADMIN', 'SUPER_ADMIN', 'PRINCIPAL')
  )
$function$;

RESET ROLE;
