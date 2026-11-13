-- Member codes: a platform-issued, human-readable ID for every student, teacher and parent.
--
-- FORMAT.
-- <KIND>-<school number><sequence>, sequence zero-padded to five digits:
--   STU-100001  -- the first student of school #1
--   TCH-200014  -- the fourteenth teacher of school #2
--   PAR-1200003 -- the third parent of school #12
-- KIND is STU (role STUDENT), TCH (role INSTRUCTOR) or PAR (role PARENT). The leading school number
-- tells support which school a code belongs to at a glance. Beyond 99,999 members of one kind the
-- sequence simply grows a digit; the global UNIQUE on `code` turns the (theoretical) overlap with a
-- higher-numbered school into a hard error rather than a duplicate.
--
-- These are separate from the school-managed admission_number / employee_number (000008): those
-- are the school's own identifiers, entered or imported by the school and editable. A member code
-- is ours: issued once, never edited, never reused -- removing the role keeps the code, and
-- granting it again returns the same one.
--
-- HOW CODES ARE ISSUED.
-- An AFTER INSERT trigger on app.user_roles, so every path that grants one of the three roles --
-- invitation activation, admin "create user", student/teacher services, the import worker --
-- issues a code without the API having to remember to. Every one of those paths runs with the
-- tenant scope armed (app.user_roles is itself tenant-isolated), which the forced policies below
-- rely on. The per-(school, kind) counter is taken with INSERT ... ON CONFLICT DO UPDATE, whose row
-- lock serializes concurrent grants in one school; a rolled-back grant leaves a gap, which is fine.
--
-- ACCESS.
-- studafy_app may only read codes; writes happen solely inside the SECURITY DEFINER issuer.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. app.schools.school_number
-- ---------------------------------------------------------------------------------------------------

CREATE SEQUENCE app.school_number_seq AS integer START WITH 1;

ALTER TABLE app.schools ADD COLUMN school_number integer;

-- Existing schools are numbered in the order they joined.
UPDATE app.schools AS s
SET school_number = numbered.n
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM app.schools) AS numbered
WHERE s.id = numbered.id;

SELECT pg_catalog.setval(
  'app.school_number_seq',
  COALESCE((SELECT max(school_number) FROM app.schools), 0) + 1,
  false
);

ALTER TABLE app.schools
  ALTER COLUMN school_number SET DEFAULT nextval('app.school_number_seq'),
  ALTER COLUMN school_number SET NOT NULL,
  ADD CONSTRAINT uq_schools_school_number UNIQUE (school_number),
  ADD CONSTRAINT ck_schools_school_number CHECK (school_number > 0);

ALTER SEQUENCE app.school_number_seq OWNED BY app.schools.school_number;

-- studafy_app inserts schools on self-registration (000035) and so draws from the sequence.
GRANT USAGE ON SEQUENCE app.school_number_seq TO studafy_app;

COMMENT ON COLUMN app.schools.school_number IS
  'Platform-assigned school number (000140); the leading digits of every member code in the school.';

-- ---------------------------------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.member_code_counters (
  school_id  uuid    NOT NULL,
  kind       text    NOT NULL,
  last_value integer NOT NULL,

  CONSTRAINT pk_member_code_counters PRIMARY KEY (school_id, kind),
  CONSTRAINT fk_member_code_counters_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_member_code_counters_kind CHECK (kind IN ('STU', 'TCH', 'PAR')),
  CONSTRAINT ck_member_code_counters_last_value CHECK (last_value > 0)
);

COMMENT ON TABLE app.member_code_counters IS
  'Last member-code sequence issued per (school, kind) (000140). Written only by app.assign_member_code.';

CREATE TABLE app.member_codes (
  id         uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_member_codes PRIMARY KEY,
  school_id  uuid        NOT NULL,
  user_id    uuid        NOT NULL,
  kind       text        NOT NULL,
  sequence   integer     NOT NULL,
  code       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_member_codes_id_school UNIQUE (id, school_id),
  -- One code per person per kind: a teacher who is also a parent holds a TCH and a PAR code.
  CONSTRAINT uq_member_codes_school_user_kind UNIQUE (school_id, user_id, kind),
  CONSTRAINT uq_member_codes_school_kind_sequence UNIQUE (school_id, kind, sequence),
  CONSTRAINT uq_member_codes_code UNIQUE (code),

  CONSTRAINT fk_member_codes_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_member_codes_user
    FOREIGN KEY (user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_member_codes_kind CHECK (kind IN ('STU', 'TCH', 'PAR')),
  CONSTRAINT ck_member_codes_sequence CHECK (sequence > 0),
  CONSTRAINT ck_member_codes_code CHECK (code ~ '^(STU|TCH|PAR)-[0-9]+$' AND left(code, 3) = kind)
);

-- The members table joins codes by user.
CREATE INDEX idx_member_codes_school_user ON app.member_codes (school_id, user_id);

COMMENT ON TABLE app.member_codes IS
  'Platform-issued member codes (000140): STU/TCH/PAR-<school number><sequence>. Issued once, never edited or reused.';

-- ---------------------------------------------------------------------------------------------------
-- 3. Issuer
-- ---------------------------------------------------------------------------------------------------

-- Issues `p_kind`'s code to the user unless they already hold one, and returns it. SECURITY DEFINER
-- because studafy_app has no write access to either table; the forced tenant policies still confine
-- it to the armed school.
CREATE FUNCTION app.assign_member_code(p_school_id uuid, p_user_id uuid, p_kind text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  existing text;
  next_sequence integer;
  number integer;
  issued text;
BEGIN
  SELECT mc.code INTO existing
  FROM app.member_codes AS mc
  WHERE mc.school_id = p_school_id AND mc.user_id = p_user_id AND mc.kind = p_kind;
  IF existing IS NOT NULL THEN
    RETURN existing;
  END IF;

  SELECT s.school_number INTO STRICT number FROM app.schools AS s WHERE s.id = p_school_id;

  INSERT INTO app.member_code_counters AS c (school_id, kind, last_value)
  VALUES (p_school_id, p_kind, 1)
  ON CONFLICT (school_id, kind) DO UPDATE SET last_value = c.last_value + 1
  RETURNING c.last_value INTO next_sequence;

  issued := p_kind || '-' || number::text
    || CASE WHEN next_sequence < 100000 THEN lpad(next_sequence::text, 5, '0')
            ELSE next_sequence::text END;

  INSERT INTO app.member_codes (school_id, user_id, kind, sequence, code)
  VALUES (p_school_id, p_user_id, p_kind, next_sequence, issued);

  RETURN issued;
END
$function$;

CREATE FUNCTION app.user_roles_assign_member_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM app.assign_member_code(
    NEW.school_id,
    NEW.user_id,
    CASE NEW.role::text WHEN 'STUDENT' THEN 'STU' WHEN 'INSTRUCTOR' THEN 'TCH' ELSE 'PAR' END
  );
  RETURN NULL;
END
$function$;

ALTER FUNCTION app.assign_member_code(uuid, uuid, text) OWNER TO studafy_admin;
ALTER FUNCTION app.user_roles_assign_member_code() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.assign_member_code(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.user_roles_assign_member_code() FROM PUBLIC;

CREATE TRIGGER trg_user_roles_assign_member_code
  AFTER INSERT ON app.user_roles
  FOR EACH ROW
  WHEN (NEW.role::text IN ('STUDENT', 'INSTRUCTOR', 'PARENT'))
  EXECUTE FUNCTION app.user_roles_assign_member_code();

-- ---------------------------------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

-- studafy_app named explicitly: 000002's default privileges would otherwise grant it DML.
REVOKE ALL PRIVILEGES ON TABLE app.member_code_counters FROM PUBLIC, studafy_app;
REVOKE ALL PRIVILEGES ON TABLE app.member_codes FROM PUBLIC, studafy_app;
GRANT SELECT ON TABLE app.member_codes TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'member_code_counters');
SELECT app.apply_tenant_isolation('app', 'member_codes');

-- ---------------------------------------------------------------------------------------------------
-- 5. Backfill
-- ---------------------------------------------------------------------------------------------------

-- Forced RLS applies to the owner too, so one tenant at a time (as 000072). Within a school, codes
-- follow the order people were granted the role.
DO $backfill$
DECLARE
  tenant_id uuid;
  grant_row record;
BEGIN
  FOR tenant_id IN SELECT id FROM app.schools ORDER BY school_number LOOP
    PERFORM pg_catalog.set_config('app.school_id', tenant_id::text, true);

    FOR grant_row IN
      SELECT ur.user_id, ur.role::text AS role
      FROM app.user_roles AS ur
      WHERE ur.school_id = tenant_id AND ur.role::text IN ('STUDENT', 'INSTRUCTOR', 'PARENT')
      ORDER BY ur.created_at, ur.user_id
    LOOP
      PERFORM app.assign_member_code(
        tenant_id,
        grant_row.user_id,
        CASE grant_row.role WHEN 'STUDENT' THEN 'STU' WHEN 'INSTRUCTOR' THEN 'TCH' ELSE 'PAR' END
      );
    END LOOP;
  END LOOP;

  PERFORM pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
END
$backfill$;

RESET ROLE;
