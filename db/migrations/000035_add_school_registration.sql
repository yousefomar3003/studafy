-- School self-registration support (ST-registration).
--
-- Adds the infrastructure for POST /api/schools/register:
-- 1. A 'registered' status for schools that have submitted registration but are not yet active.
-- 2. email/normalized_email columns on app.schools so duplicate school emails can be caught
--    with a unique index and clear application-level error messages.
-- 3. INSERT/UPDATE grants on app.schools to studafy_app so the registration transaction
--    (which runs as studafy_app after the school row is created) can write future admin APIs.

SET ROLE studafy_admin;

-- 1. Add 'registered' to the school_status enum.
--    ADD VALUE IF NOT EXISTS is safe for concurrent migration attempts.
ALTER TYPE app.school_status ADD VALUE IF NOT EXISTS 'registered';

-- 2. Add email columns to app.schools.
--    Nullable first so existing rows can be backfilled, then tightened.
ALTER TABLE app.schools
  ADD COLUMN email text,
  ADD COLUMN normalized_email text;

-- 3. Backfill existing rows. The demo school gets a slug-derived placeholder.
UPDATE app.schools SET
  email = 'admin@' || slug || '.local',
  normalized_email = lower(btrim('admin@' || slug || '.local'))
WHERE email IS NULL;

-- 4. Make columns NOT NULL after backfill.
ALTER TABLE app.schools
  ALTER COLUMN email SET NOT NULL,
  ALTER COLUMN normalized_email SET NOT NULL;

-- 5. Unique index on normalized_email for duplicate detection.
CREATE UNIQUE INDEX uq_schools_normalized_email ON app.schools (normalized_email);

-- 6. CHECK constraints matching the pattern in app.users / app.invitations.
ALTER TABLE app.schools ADD CONSTRAINT ck_schools_email CHECK (
  email = btrim(email) AND email <> '' AND char_length(email) <= 320
);
ALTER TABLE app.schools ADD CONSTRAINT ck_schools_normalized_email CHECK (
  normalized_email = lower(btrim(normalized_email))
  AND normalized_email <> ''
  AND char_length(normalized_email) <= 320
);

-- 7. Grant INSERT/UPDATE on schools to studafy_app.
--    The registration transaction itself uses studafy_admin for the school INSERT
--    (via SET LOCAL ROLE), but future admin APIs need studafy_app write access.
GRANT INSERT, UPDATE ON TABLE app.schools TO studafy_app;

-- 8. Revoke from PUBLIC as a defense-in-depth measure (studafy_app already has explicit grants).
REVOKE INSERT, UPDATE ON TABLE app.schools FROM PUBLIC;

RESET ROLE;
