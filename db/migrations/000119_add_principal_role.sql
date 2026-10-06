-- studafy:migration transaction=off
--
-- Add PRINCIPAL to app.user_role.
--
-- Mirrors ROLES.PRINCIPAL in packages/constants/src/roles.ts. A school principal: leadership
-- oversight of attendance, discipline, staff evaluations, approvals and announcements, without the
-- ORG_ADMIN ops console (users, roles, settings, billing). The permission set is PRINCIPAL_PERMISSIONS
-- in packages/constants/src/permissions.ts; school-wide row visibility is granted separately in
-- 000120, because that migration has to reference the new value.
--
-- transaction=off is required, not stylistic: PostgreSQL forbids USING a new enum value in the same
-- transaction that added it, and the migration runner wraps every transactional migration in
-- BEGIN/COMMIT. IF NOT EXISTS keeps a re-run a no-op rather than a duplicate_object error, which the
-- runner requires of every non-transactional migration.

SET ROLE studafy_admin;

ALTER TYPE app.user_role ADD VALUE IF NOT EXISTS 'PRINCIPAL';

RESET ROLE;
