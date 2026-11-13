-- School closure by the school's own administrator (POST /api/schools/current/closure).
--
-- Closing a school moves app.schools.status to 'archived' -- the existing terminal lifecycle state --
-- and keeps every row the school owns. Nothing is erased: closure is not a deletion and files no
-- data subject request. The API also revokes every session in the school and bumps the school's
-- entitlement version in the same transaction, so outstanding access tokens die immediately and
-- the sign-in paths refuse the school from then on (see apps/api/src/modules/tenancy/closure).
--
-- 1. closed_at / closed_by -- when, and by whom, the school was closed. Recorded on the row itself
--    so "is this school closed, since when, by which admin" is answerable without searching the
--    partitioned audit log. Both stay NULL for a school archived by the platform console, which is
--    an operator decision with its own audit trail rather than a closure.
-- 2. The two are set together, and only on an archived school.
--
-- app.schools is a global table without RLS; studafy_app already holds UPDATE on it (000035).
-- closed_by deliberately has no foreign key: app.users rows are tenant-scoped and may be detached
-- by account deletion, and the closure record must outlive the account that made it.

SET ROLE studafy_admin;

ALTER TABLE app.schools
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by uuid;

ALTER TABLE app.schools
  ADD CONSTRAINT ck_schools_closure CHECK (
    (closed_at IS NULL) = (closed_by IS NULL)
    AND (closed_at IS NULL OR status = 'archived')
  );

RESET ROLE;
