-- studafy:migration transaction=off
--
-- Add ATTENDANCE_OFFICER to app.user_role.
--
-- Mirrors ROLES.ATTENDANCE_OFFICER in packages/constants/src/roles.ts. A school attendance officer:
-- takes and corrects attendance for every class in the school and works its reports, from their own
-- portal (/portal/attendance), without leadership oversight (grades, approvals, discipline,
-- evaluations) or the ORG_ADMIN ops console. The permission set is ATTENDANCE_OFFICER_PERMISSIONS in
-- packages/constants/src/permissions.ts; the school-wide attendance row visibility it needs is granted
-- separately in 000133, because that migration has to reference the new value.
--
-- transaction=off for the same reason as 000119: PostgreSQL forbids USING a new enum value in the
-- transaction that added it. IF NOT EXISTS keeps a re-run a no-op.

SET ROLE studafy_admin;

ALTER TYPE app.user_role ADD VALUE IF NOT EXISTS 'ATTENDANCE_OFFICER';

RESET ROLE;
