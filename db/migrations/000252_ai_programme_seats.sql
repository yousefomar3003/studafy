-- Student AI programme seats (owner's rules of 2026-11-18, docs/billing/ai-programme.md
-- "Programme seats and access"):
--
-- * A parent opt-in no longer takes one of the seats the school bought on its licence: it holds a
--   programme seat (`license_seats.programme`), outside the licence's priced capacity -- no minimum
--   seats, no seat request, no waiting. The school pays for it month by month, as parents pay, on
--   its weekly statements (000251).
--
-- * A programme seat gives Student AI only in the months the school has paid Studafy for
--   (`student_ai_months` activated). `app.student_ai_active_months` reads them for the entitlement
--   resolver, which runs without an acting user (the months' role-scope policy would hide them).
--
-- * Seats assigned before this keep `programme = false`: the school already paid for them on its
--   licence, so they keep covering their holders as before and are never billed again.

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

ALTER TABLE app.license_seats
  ADD COLUMN programme boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT ck_license_seats_programme CHECK (NOT programme OR audience = 'student');

COMMENT ON COLUMN app.license_seats.programme IS
  'A Student AI programme seat (000252): held by a parent opt-in, outside the licence''s priced capacity, covering its holder only in the months the school paid for (student_ai_months activated).';

-- Capacity and eligibility, on every new seat. A programme seat is outside the licence's priced
-- capacity: it is neither counted nor capped.
CREATE OR REPLACE FUNCTION app.license_seats_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  license_status text;
  purchased integer;
  assigned integer;
BEGIN
  IF NEW.unassigned_at IS NOT NULL THEN
    RAISE EXCEPTION 'a seat is created assigned'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_seats_unassigned',
            TABLE = 'license_seats', SCHEMA = 'app';
  END IF;

  -- The row lock is what serializes concurrent assignments on one license: the second waits here
  -- until the first commits, and its count below then sees the first's seat.
  SELECT l.status,
         CASE NEW.audience
           WHEN 'student' THEN l.student_seats
           WHEN 'teacher' THEN l.teacher_seats
           WHEN 'parent' THEN CASE WHEN l.include_family_plus THEN l.parent_seats ELSE 0 END
           ELSE 0
         END
    INTO license_status, purchased
  FROM app.school_licenses AS l
  WHERE l.id = NEW.license_id
    AND l.school_id = NEW.school_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- fk_license_seats_license reports it.
    RETURN NEW;
  END IF;

  IF license_status NOT IN ('draft', 'awaiting_payment', 'active') THEN
    RAISE EXCEPTION 'license % is % and takes no new seats', NEW.license_id, license_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_seats_license_open',
            TABLE = 'license_seats', SCHEMA = 'app';
  END IF;

  IF NOT app.license_seat_eligible(NEW.audience, NEW.user_id, NEW.student_id) THEN
    RAISE EXCEPTION 'user % cannot hold a % seat in this school', NEW.user_id, NEW.audience
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_seats_eligible',
            TABLE = 'license_seats', SCHEMA = 'app';
  END IF;

  IF NEW.programme THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
    INTO assigned
  FROM app.license_seats AS s
  WHERE s.school_id = NEW.school_id
    AND s.license_id = NEW.license_id
    AND s.audience = NEW.audience
    AND s.unassigned_at IS NULL
    AND NOT s.programme;

  IF assigned >= purchased THEN
    RAISE EXCEPTION 'all % % seats of license % are assigned', purchased, NEW.audience, NEW.license_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_seats_capacity',
            TABLE = 'license_seats', SCHEMA = 'app';
  END IF;

  RETURN NEW;
END
$function$;

-- A seat changes once: from assigned to unassigned. Everything else about it is history.
CREATE OR REPLACE FUNCTION app.license_seats_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.unassigned_at IS NOT NULL
     OR NEW.unassigned_at IS NULL
     OR (NEW.license_id, NEW.audience, NEW.user_id, NEW.student_id, NEW.assigned_at,
         NEW.assigned_by, NEW.assigned_by_platform, NEW.programme)
        IS DISTINCT FROM
        (OLD.license_id, OLD.audience, OLD.user_id, OLD.student_id, OLD.assigned_at,
         OLD.assigned_by, OLD.assigned_by_platform, OLD.programme)
  THEN
    RAISE EXCEPTION 'a seat can only be unassigned, once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_seats_unassign_only',
            TABLE = 'license_seats', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

-- A license's seat counts can never drop below the seats already assigned -- the seats it priced,
-- not the programme seats outside them.
CREATE OR REPLACE FUNCTION app.school_licenses_check_assigned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  slot record;
  purchased integer;
BEGIN
  FOR slot IN
    SELECT s.audience, count(*) AS assigned
    FROM app.license_seats AS s
    WHERE s.school_id = NEW.school_id
      AND s.license_id = NEW.id
      AND s.unassigned_at IS NULL
      AND NOT s.programme
    GROUP BY s.audience
  LOOP
    -- A variable, not an inline CASE: PL/pgSQL reads an IF condition up to its first THEN.
    purchased := CASE slot.audience
      WHEN 'student' THEN NEW.student_seats
      WHEN 'teacher' THEN NEW.teacher_seats
      ELSE CASE WHEN NEW.include_family_plus THEN NEW.parent_seats ELSE 0 END
    END;
    IF slot.assigned > purchased THEN
      RAISE EXCEPTION '% % seats are assigned on license %', slot.assigned, slot.audience, NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_school_licenses_seats_assigned',
              TABLE = 'school_licenses', SCHEMA = 'app';
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$;

-- The months a student has Student AI from a programme seat: the activated ones, in the armed
-- school. For the entitlement resolver, which runs without an acting user.
CREATE FUNCTION app.student_ai_active_months(student uuid)
RETURNS date[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT COALESCE(array_agg(m.month ORDER BY m.month), '{}'::date[])
  FROM app.student_ai_months AS m
  WHERE m.school_id = NULLIF(pg_catalog.current_setting('app.school_id', true), '')::uuid
    AND m.student_id = student
    AND m.status = 'activated'
$function$;

REVOKE ALL ON FUNCTION app.student_ai_active_months(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_ai_active_months(uuid) TO studafy_app;

COMMENT ON FUNCTION app.student_ai_active_months(uuid) IS
  'The months a student has Student AI from a programme seat (student_ai_months activated), in the armed school (000252).';

RESET ROLE;
