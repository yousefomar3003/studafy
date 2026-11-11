-- A phone number on a person's school account (app.users), so a school can reach the parents and
-- teachers it imports. The import templates require one for every parent and teacher they create
-- (packages/student-import "parent_phone" / "parent2_phone", the Teachers import's "phone").
--
-- Contact data only: NEVER used to find, match or link people (docs/modules/finance-module-guide.md
-- "How parents and children get linked"), so it has no index and no uniqueness -- two parents can
-- share a home phone. Erasure redacts it like every other `phone` column
-- (apps/workers/src/queues/maintenance/retention-registry.ts PII_COLUMN_PATTERNS).

SET ROLE studafy_admin;

-- Validating the CHECK scans app.users, whose forced RLS applies the tenant_isolation predicate even
-- to the owner (see 000114, 000198). The new column is NULL on every existing row, so the nil
-- tenant's empty scan is exact.
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

ALTER TABLE app.users
  ADD COLUMN phone text,
  ADD CONSTRAINT ck_users_phone CHECK (
    phone IS NULL OR (phone = btrim(phone) AND phone <> '' AND char_length(phone) <= 50)
  );

COMMENT ON COLUMN app.users.phone IS
  'Contact phone as the school typed it (000203). Never used to match or link people.';

RESET ROLE;
