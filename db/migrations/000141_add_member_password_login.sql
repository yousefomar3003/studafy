-- Member-ID + password sign-in for students, parents, teachers and attendance officers.
--
-- Schools sign these people up without email addresses: their username is the member code issued in
-- 000140 (STU/TCH/PAR, plus ATT for attendance officers added here) and their password starts as the
-- platform default, which they must replace before they get a session (enforced by the API, not the
-- client: a sign-in with the default password issues no tokens). School leadership (ORG_ADMIN,
-- PRINCIPAL, FINANCE) keeps signing in with Google or Microsoft only; the API refuses password
-- sign-in for any account holding a privileged role.
--
-- 1. app.users.email becomes optional. Both email columns are NULL together or set together; the
--    per-school uniqueness on normalized_email is unaffected (NULLs are distinct).
-- 2. Member codes gain the ATT kind for ATTENDANCE_OFFICER, backfilled like 000140.
-- 3. app.member_credentials holds each member's password hash and lockout state. A member with no
--    row, or a NULL hash, still has the default password; an admin "reset" returns them to it.
--    Hashes are produced by the API (argon2id); the database never sees a plaintext password.
-- 4. app.resolve_member_code_for_login(code) finds the account for a code before any tenant scope
--    exists. The code carries its school number, so the function arms that one school's scope
--    rather than opening a cross-tenant read path.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Optional email
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.users
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN normalized_email DROP NOT NULL,
  ADD CONSTRAINT ck_users_email_pair CHECK ((email IS NULL) = (normalized_email IS NULL));

COMMENT ON COLUMN app.users.email IS
  'Display-form email; NULL for members who sign in with their member code and a password (000141).';

-- ---------------------------------------------------------------------------------------------------
-- 2. ATT member codes
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.member_code_counters
  DROP CONSTRAINT ck_member_code_counters_kind,
  ADD CONSTRAINT ck_member_code_counters_kind CHECK (kind IN ('STU', 'TCH', 'PAR', 'ATT'));

ALTER TABLE app.member_codes
  DROP CONSTRAINT ck_member_codes_kind,
  DROP CONSTRAINT ck_member_codes_code,
  ADD CONSTRAINT ck_member_codes_kind CHECK (kind IN ('STU', 'TCH', 'PAR', 'ATT')),
  ADD CONSTRAINT ck_member_codes_code
    CHECK (code ~ '^(STU|TCH|PAR|ATT)-[0-9]+$' AND left(code, 3) = kind);

CREATE OR REPLACE FUNCTION app.user_roles_assign_member_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM app.assign_member_code(
    NEW.school_id,
    NEW.user_id,
    CASE NEW.role::text
      WHEN 'STUDENT' THEN 'STU'
      WHEN 'INSTRUCTOR' THEN 'TCH'
      WHEN 'ATTENDANCE_OFFICER' THEN 'ATT'
      ELSE 'PAR'
    END
  );
  RETURN NULL;
END
$function$;

DROP TRIGGER trg_user_roles_assign_member_code ON app.user_roles;
CREATE TRIGGER trg_user_roles_assign_member_code
  AFTER INSERT ON app.user_roles
  FOR EACH ROW
  WHEN (NEW.role::text IN ('STUDENT', 'INSTRUCTOR', 'PARENT', 'ATTENDANCE_OFFICER'))
  EXECUTE FUNCTION app.user_roles_assign_member_code();

DO $backfill$
DECLARE
  tenant_id uuid;
  grant_row record;
BEGIN
  FOR tenant_id IN SELECT id FROM app.schools ORDER BY school_number LOOP
    PERFORM pg_catalog.set_config('app.school_id', tenant_id::text, true);
    FOR grant_row IN
      SELECT ur.user_id
      FROM app.user_roles AS ur
      WHERE ur.school_id = tenant_id AND ur.role::text = 'ATTENDANCE_OFFICER'
      ORDER BY ur.created_at, ur.user_id
    LOOP
      PERFORM app.assign_member_code(tenant_id, grant_row.user_id, 'ATT');
    END LOOP;
  END LOOP;
  PERFORM pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
END
$backfill$;

-- ---------------------------------------------------------------------------------------------------
-- 3. Credentials
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.member_credentials (
  school_id           uuid        NOT NULL,
  user_id             uuid        NOT NULL,
  -- NULL means the member still has the platform default password and must change it.
  password_hash       text,
  password_changed_at timestamptz,
  failed_attempts     smallint    NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT pk_member_credentials PRIMARY KEY (school_id, user_id),
  CONSTRAINT fk_member_credentials_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_member_credentials_user
    FOREIGN KEY (user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_member_credentials_hash CHECK (
    password_hash IS NULL OR (password_hash LIKE '$argon2id$%' AND char_length(password_hash) <= 512)
  ),
  CONSTRAINT ck_member_credentials_changed CHECK ((password_hash IS NULL) = (password_changed_at IS NULL)),
  CONSTRAINT ck_member_credentials_failed_attempts CHECK (failed_attempts BETWEEN 0 AND 1000),
  CONSTRAINT ck_member_credentials_timestamps CHECK (updated_at >= created_at)
);

COMMENT ON TABLE app.member_credentials IS
  'Member-code sign-in secrets (000141): argon2id hash (NULL = default password, change required) and lockout state.';

REVOKE ALL PRIVILEGES ON TABLE app.member_credentials FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.member_credentials TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'member_credentials');

-- ---------------------------------------------------------------------------------------------------
-- 4. Login resolver
-- ---------------------------------------------------------------------------------------------------

-- Returns exactly one row: (found, user_id, school_id), nil UUIDs when nothing matches, so callers do
-- the same work for a hit and a miss. The digits after the kind are <school number><sequence>, the
-- sequence at least five digits; every split leaving five or more trailing digits is tried, and
-- uq_member_codes_code guarantees at most one of them matches.
CREATE FUNCTION app.resolve_member_code_for_login(p_code text)
RETURNS TABLE (found boolean, user_id uuid, school_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized text := upper(btrim(coalesce(p_code, '')));
  digits text;
  split integer;
  candidate_school uuid;
  hit record;
  -- Locals rather than the OUT columns: `found` would shadow PL/pgSQL's FOUND, which every
  -- statement below rewrites.
  hit_found boolean := false;
  hit_user uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  hit_school uuid := '00000000-0000-0000-0000-000000000000'::uuid;
BEGIN

  IF normalized ~ '^(STU|TCH|PAR|ATT)-[0-9]{6,12}$' THEN
    digits := substr(normalized, 5);
    FOR split IN 1 .. char_length(digits) - 5 LOOP
      SELECT s.id INTO candidate_school
      FROM app.schools AS s
      WHERE s.school_number = substr(digits, 1, split)::integer;
      CONTINUE WHEN candidate_school IS NULL;

      PERFORM pg_catalog.set_config('app.school_id', candidate_school::text, true);
      SELECT mc.user_id, mc.school_id INTO hit
      FROM app.member_codes AS mc
      WHERE mc.school_id = candidate_school AND mc.code = normalized;
      IF hit.user_id IS NOT NULL THEN
        hit_found := true;
        hit_user := hit.user_id;
        hit_school := hit.school_id;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  -- Leave no tenant armed; the caller arms the resolved school itself.
  PERFORM pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
  RETURN QUERY SELECT hit_found, hit_user, hit_school;
END
$function$;

ALTER FUNCTION app.resolve_member_code_for_login(text) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.resolve_member_code_for_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_member_code_for_login(text) TO studafy_app;

RESET ROLE;
