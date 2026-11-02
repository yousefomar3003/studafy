-- School feature licenses and seats: session 2 of docs/billing/feature-licensing.md.
--
-- A school license sells feature tiers to a school, per audience: a tier and a seat count for its
-- students, its teachers and -- when the license includes Family+ -- its parents. Only people the
-- school assigns a seat to are covered; being in the school is not enough.
--
--   * app.school_licenses        -- one license: status, period, a tier and seat count per audience,
--                                   currency. At most one active license per school.
--   * app.license_seats          -- one seat held by one person on one license. Unassigning keeps the
--                                   row (unassigned_at), so seat history is the table itself.
--   * app.license_seat_overlaps  -- a seat given to someone who already pays personally: the overlap
--                                   credit the school is owed on its invoice (session 3) and what was
--                                   done about the personal subscription's renewal.
--   * app.license_change_requests -- a school asking the super admin for different seats.
--   * app.ai_subscriptions.cancel_at_period_end -- lets a seat stop a Tap-billed AI add-on renewing
--                                   (the Tap renewal worker reads it, as it already does for schools).
--
-- Two rules are the database's, not the API's, because they must hold under concurrency and for
-- every writer (the school's console, the super admin's, any future job):
--
--   1. Assigned seats never exceed purchased seats. trg_license_seats_before_insert locks the license
--      row (FOR UPDATE) before counting, so two concurrent assignments on one license serialize and
--      the second sees the first's seat. A license update that lowers a seat count takes the same row
--      lock and is refused below the seats already assigned.
--   2. A seat holder belongs to the school in the seat's audience: an enrolled student (the seat
--      names their student record), an active or on-leave teacher, or a parent linked to an enrolled
--      student. app.license_seat_eligible() is the one definition, used by the trigger and by the
--      API's "who can still get a seat" list.
--
-- Trigger refusals are raised as check_violation with a named constraint
-- (ck_license_seats_capacity, ck_license_seats_eligible, ...) so the API maps them to coded errors.
--
-- Like the 000037 helpers, the trigger functions and the eligibility check are SECURITY DEFINER,
-- owned by studafy_admin: they read students, teachers and parent links, whose role-scope policies
-- (TO studafy_app) would otherwise depend on who is assigning. tenant_isolation still applies inside,
-- and every lookup pins the armed school.
--
-- created_by, assigned_by, unassigned_by and resolved_by carry no foreign key: the super admin who
-- acts on a school is a user of their own home school, not of this one (the same reason the platform
-- console audits in two schools -- see modules/platform/service.ts). requested_by, always a member of
-- this school, does carry one.
--
-- Depends on 000004 (plans, currencies), 000007 (users), 000008 (students, teachers, parent links),
-- 000016 (ai_subscriptions), 000161 (tiers, user_subscriptions).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. app.school_licenses
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.school_licenses (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_school_licenses PRIMARY KEY,
  school_id uuid NOT NULL,
  -- draft: the super admin is preparing it. awaiting_payment: sent to the school. active: in force.
  -- expired: past its end. cancelled: ended early. suspended: paused by the super admin (resumable).
  status text NOT NULL DEFAULT 'draft',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  student_plan_id uuid,
  student_seats integer NOT NULL DEFAULT 0,
  teacher_plan_id uuid,
  teacher_seats integer NOT NULL DEFAULT 0,
  include_family_plus boolean NOT NULL DEFAULT false,
  parent_plan_id uuid,
  parent_seats integer NOT NULL DEFAULT 0,
  currency_id uuid NOT NULL,
  notes text,
  created_by uuid NOT NULL,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_school_licenses_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_school_licenses_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_school_licenses_student_plan FOREIGN KEY (student_plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_school_licenses_teacher_plan FOREIGN KEY (teacher_plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_school_licenses_parent_plan FOREIGN KEY (parent_plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_school_licenses_currency FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_school_licenses_status CHECK (
    status IN ('draft', 'awaiting_payment', 'active', 'expired', 'cancelled', 'suspended')
  ),
  CONSTRAINT ck_school_licenses_period CHECK (ends_at > starts_at),
  CONSTRAINT ck_school_licenses_seats CHECK (
    student_seats >= 0 AND teacher_seats >= 0 AND parent_seats >= 0
  ),
  -- Seats are sold in a tier: an audience with seats has a tier.
  CONSTRAINT ck_school_licenses_student_tier CHECK (student_seats = 0 OR student_plan_id IS NOT NULL),
  CONSTRAINT ck_school_licenses_teacher_tier CHECK (teacher_seats = 0 OR teacher_plan_id IS NOT NULL),
  CONSTRAINT ck_school_licenses_parent_tier CHECK (parent_seats = 0 OR parent_plan_id IS NOT NULL),
  -- Parent seats exist only on a license that includes Family+.
  CONSTRAINT ck_school_licenses_family_plus CHECK (
    include_family_plus OR (parent_plan_id IS NULL AND parent_seats = 0)
  ),
  -- A license that was ever active records when it became so.
  CONSTRAINT ck_school_licenses_activated CHECK (
    status IN ('draft', 'awaiting_payment') OR activated_at IS NOT NULL OR status = 'cancelled'
  ),
  CONSTRAINT ck_school_licenses_notes CHECK (notes IS NULL OR (notes = btrim(notes) AND notes <> '')),
  CONSTRAINT ck_school_licenses_timestamps CHECK (updated_at >= created_at)
);

-- At most one active license per school.
CREATE UNIQUE INDEX uq_school_licenses_one_active
  ON app.school_licenses (school_id)
  WHERE status = 'active';
-- A school's licenses, newest first (the school's "current license" and the console's list).
CREATE INDEX idx_school_licenses_school_status
  ON app.school_licenses (school_id, status, starts_at DESC);

-- Each tier must be a tier of its own audience. A cross-table rule, so a trigger.
CREATE FUNCTION app.school_licenses_check_tiers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  slot record;
BEGIN
  FOR slot IN
    SELECT * FROM (VALUES
      ('student', NEW.student_plan_id),
      ('teacher', NEW.teacher_plan_id),
      ('parent', NEW.parent_plan_id)
    ) AS t (audience, plan_id)
    WHERE t.plan_id IS NOT NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM app.plans AS p WHERE p.id = slot.plan_id AND p.audience = slot.audience
    ) THEN
      RAISE EXCEPTION 'plan % is not a % tier', slot.plan_id, slot.audience
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_school_licenses_tier_audience',
              TABLE = 'school_licenses', SCHEMA = 'app';
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_school_licenses_check_tiers
  BEFORE INSERT OR UPDATE OF student_plan_id, teacher_plan_id, parent_plan_id
  ON app.school_licenses
  FOR EACH ROW EXECUTE FUNCTION app.school_licenses_check_tiers();

-- ---------------------------------------------------------------------------------------------------
-- 2. app.license_seats
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.license_seats (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_license_seats PRIMARY KEY,
  school_id uuid NOT NULL,
  license_id uuid NOT NULL,
  audience text NOT NULL,
  user_id uuid NOT NULL,
  -- The student record, for a student seat: the AI add-on and the AI routes are keyed by it.
  student_id uuid,
  assigned_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by uuid NOT NULL,
  -- True when the super admin assigned it on the school's behalf.
  assigned_by_platform boolean NOT NULL DEFAULT false,
  unassigned_at timestamptz,
  unassigned_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_license_seats_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_license_seats_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_seats_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_seats_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_seats_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_seats_audience CHECK (audience IN ('student', 'teacher', 'parent')),
  CONSTRAINT ck_license_seats_student CHECK ((audience = 'student') = (student_id IS NOT NULL)),
  CONSTRAINT ck_license_seats_unassigned CHECK (
    (unassigned_at IS NULL) = (unassigned_by IS NULL)
    AND (unassigned_at IS NULL OR unassigned_at >= assigned_at)
  ),
  CONSTRAINT ck_license_seats_timestamps CHECK (updated_at >= created_at)
);

-- One active seat per person per audience per license. Per audience, not per license: a teacher who
-- is also a parent at the school can hold a teacher seat and a Family+ parent seat, each counted
-- against its own purchased seats.
CREATE UNIQUE INDEX uq_license_seats_active_person
  ON app.license_seats (school_id, license_id, audience, user_id)
  WHERE unassigned_at IS NULL;
-- The resolver's read (a person's seats) and the composite user foreign key.
CREATE INDEX idx_license_seats_school_user ON app.license_seats (school_id, user_id);
-- A license's seats per audience, newest first (seat lists, counts) and the license foreign key.
CREATE INDEX idx_license_seats_school_license
  ON app.license_seats (school_id, license_id, audience, assigned_at DESC);
-- The composite student foreign key.
CREATE INDEX idx_license_seats_school_student ON app.license_seats (school_id, student_id);

-- Whether a person can hold a seat of `target_audience` in the armed school. The one definition of
-- eligibility: the seat trigger and the API's eligible-people list both call it.
CREATE FUNCTION app.license_seat_eligible(
  target_audience text,
  target_user_id uuid,
  target_student_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.users AS u
    WHERE u.id = target_user_id
      AND u.school_id = current_setting('app.school_id')::uuid
      AND u.status IN ('invited', 'active')
  )
  AND CASE target_audience
    WHEN 'student' THEN EXISTS (
      SELECT 1
      FROM app.students AS s
      WHERE s.id = target_student_id
        AND s.user_id = target_user_id
        AND s.school_id = current_setting('app.school_id')::uuid
        AND s.status = 'enrolled'
    )
    WHEN 'teacher' THEN EXISTS (
      SELECT 1
      FROM app.teachers AS t
      WHERE t.user_id = target_user_id
        AND t.school_id = current_setting('app.school_id')::uuid
        AND t.employment_status IN ('active', 'on_leave')
    )
    WHEN 'parent' THEN EXISTS (
      SELECT 1
      FROM app.parent_child_links AS pcl
      JOIN app.students AS s
        ON s.id = pcl.student_id
       AND s.school_id = pcl.school_id
      WHERE pcl.parent_user_id = target_user_id
        AND pcl.school_id = current_setting('app.school_id')::uuid
        AND s.status = 'enrolled'
    )
    ELSE false
  END
$function$;

-- Capacity and eligibility, on every new seat.
CREATE FUNCTION app.license_seats_before_insert()
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

  SELECT count(*)
    INTO assigned
  FROM app.license_seats AS s
  WHERE s.school_id = NEW.school_id
    AND s.license_id = NEW.license_id
    AND s.audience = NEW.audience
    AND s.unassigned_at IS NULL;

  IF assigned >= purchased THEN
    RAISE EXCEPTION 'all % % seats of license % are assigned', purchased, NEW.audience, NEW.license_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_seats_capacity',
            TABLE = 'license_seats', SCHEMA = 'app';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_license_seats_before_insert
  BEFORE INSERT ON app.license_seats
  FOR EACH ROW EXECUTE FUNCTION app.license_seats_before_insert();

-- A seat changes once: from assigned to unassigned. Everything else about it is history.
CREATE FUNCTION app.license_seats_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.unassigned_at IS NOT NULL
     OR NEW.unassigned_at IS NULL
     OR (NEW.license_id, NEW.audience, NEW.user_id, NEW.student_id, NEW.assigned_at,
         NEW.assigned_by, NEW.assigned_by_platform)
        IS DISTINCT FROM
        (OLD.license_id, OLD.audience, OLD.user_id, OLD.student_id, OLD.assigned_at,
         OLD.assigned_by, OLD.assigned_by_platform)
  THEN
    RAISE EXCEPTION 'a seat can only be unassigned, once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_seats_unassign_only',
            TABLE = 'license_seats', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_license_seats_before_update
  BEFORE UPDATE ON app.license_seats
  FOR EACH ROW EXECUTE FUNCTION app.license_seats_before_update();

-- A license's seat counts can never drop below the seats already assigned. Same row lock as the seat
-- trigger (an UPDATE holds it), so a concurrent assignment and a reduction cannot both pass.
CREATE FUNCTION app.school_licenses_check_assigned()
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

CREATE TRIGGER trg_school_licenses_check_assigned
  BEFORE UPDATE OF student_seats, teacher_seats, parent_seats, include_family_plus
  ON app.school_licenses
  FOR EACH ROW EXECUTE FUNCTION app.school_licenses_check_assigned();

-- ---------------------------------------------------------------------------------------------------
-- 3. app.license_seat_overlaps
-- ---------------------------------------------------------------------------------------------------

-- Written when a seat starts covering someone who already pays personally (on assignment to an
-- active license, or for every seat when the license is activated). One row per (seat, personal
-- subscription); a re-run is a no-op. Session 3 turns credit_minor into an invoice line.
CREATE TABLE app.license_seat_overlaps (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_license_seat_overlaps PRIMARY KEY,
  school_id uuid NOT NULL,
  license_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- The personal subscription: an AI add-on or a personal tier purchase, exactly one.
  ai_subscription_id uuid,
  user_subscription_id uuid,
  -- app_store | google_play | tap | stripe, or NULL when the purchase has no provider on record.
  provider text,
  -- Overlap: from when the seat covers them to when the personal period ends (capped at the license
  -- end). overlap_days is whole days, rounded up.
  overlap_starts_at timestamptz NOT NULL,
  overlap_ends_at timestamptz NOT NULL,
  overlap_days integer NOT NULL,
  currency_id uuid NOT NULL,
  -- The tier's monthly seat price in the license currency, the daily price derived from it
  -- (monthly x 12 / 365) and the credit (overlap_days x daily, rounded to the minor unit). All three
  -- NULL when the tier has no monthly price in that currency yet; session 3 prices it at invoicing.
  monthly_seat_price_minor bigint,
  daily_seat_price_minor numeric(20, 6),
  credit_minor bigint,
  -- cancel_at_period_end: Stripe, Tap, Google Play. notify_user: App Store (only the user can turn
  -- renewal off). none: renewal was already off, or the purchase is not renewing (a trial, no
  -- provider on record).
  renewal_action text NOT NULL,
  renewal_status text NOT NULL,
  renewal_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_license_seat_overlaps_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_license_seat_overlaps_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_seat_overlaps_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_seat_overlaps_seat FOREIGN KEY (seat_id, school_id)
    REFERENCES app.license_seats (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_seat_overlaps_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_seat_overlaps_ai_subscription FOREIGN KEY (ai_subscription_id, school_id)
    REFERENCES app.ai_subscriptions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_seat_overlaps_user_subscription FOREIGN KEY (user_subscription_id, school_id)
    REFERENCES app.user_subscriptions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_seat_overlaps_currency FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_seat_overlaps_subscription CHECK (
    (ai_subscription_id IS NULL) <> (user_subscription_id IS NULL)
  ),
  CONSTRAINT ck_license_seat_overlaps_provider CHECK (
    provider IS NULL OR provider IN ('app_store', 'google_play', 'tap', 'stripe')
  ),
  CONSTRAINT ck_license_seat_overlaps_period CHECK (
    overlap_ends_at >= overlap_starts_at AND overlap_days >= 0
  ),
  CONSTRAINT ck_license_seat_overlaps_price CHECK (
    (monthly_seat_price_minor IS NULL) = (credit_minor IS NULL)
    AND (daily_seat_price_minor IS NULL) = (credit_minor IS NULL)
    AND (credit_minor IS NULL OR (credit_minor >= 0 AND monthly_seat_price_minor >= 0))
  ),
  CONSTRAINT ck_license_seat_overlaps_renewal_action CHECK (
    renewal_action IN ('cancel_at_period_end', 'notify_user', 'none')
  ),
  CONSTRAINT ck_license_seat_overlaps_renewal_status CHECK (
    renewal_status IN ('pending', 'done', 'failed', 'not_needed')
    AND (renewal_action <> 'none' OR renewal_status = 'not_needed')
    AND ((renewal_status = 'failed') = (renewal_error IS NOT NULL))
  ),
  CONSTRAINT ck_license_seat_overlaps_timestamps CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX uq_license_seat_overlaps_seat_ai_subscription
  ON app.license_seat_overlaps (school_id, seat_id, ai_subscription_id)
  WHERE ai_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX uq_license_seat_overlaps_seat_user_subscription
  ON app.license_seat_overlaps (school_id, seat_id, user_subscription_id)
  WHERE user_subscription_id IS NOT NULL;
-- A license's credits (session 3's invoice) and the license foreign key.
CREATE INDEX idx_license_seat_overlaps_school_license
  ON app.license_seat_overlaps (school_id, license_id, created_at);
-- The seat and user foreign keys.
CREATE INDEX idx_license_seat_overlaps_school_seat ON app.license_seat_overlaps (school_id, seat_id);
CREATE INDEX idx_license_seat_overlaps_school_user ON app.license_seat_overlaps (school_id, user_id);

-- ---------------------------------------------------------------------------------------------------
-- 4. app.license_change_requests
-- ---------------------------------------------------------------------------------------------------

-- The school asks; the super admin decides and changes the license. Requested counts are the totals
-- the school wants, NULL meaning "no change".
CREATE TABLE app.license_change_requests (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_license_change_requests PRIMARY KEY,
  school_id uuid NOT NULL,
  license_id uuid,
  student_seats integer,
  teacher_seats integer,
  parent_seats integer,
  include_family_plus boolean,
  note text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  requested_by uuid NOT NULL,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_license_change_requests_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_license_change_requests_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_change_requests_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_license_change_requests_requested_by FOREIGN KEY (requested_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_license_change_requests_seats CHECK (
    (student_seats IS NULL OR student_seats >= 0)
    AND (teacher_seats IS NULL OR teacher_seats >= 0)
    AND (parent_seats IS NULL OR parent_seats >= 0)
  ),
  CONSTRAINT ck_license_change_requests_note CHECK (note = btrim(note) AND note <> ''),
  CONSTRAINT ck_license_change_requests_status CHECK (status IN ('open', 'resolved', 'declined')),
  CONSTRAINT ck_license_change_requests_resolution CHECK (
    (status = 'open') = (resolved_at IS NULL AND resolved_by IS NULL)
  ),
  CONSTRAINT ck_license_change_requests_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_license_change_requests_school_status
  ON app.license_change_requests (school_id, status, created_at DESC);
CREATE INDEX idx_license_change_requests_school_license
  ON app.license_change_requests (school_id, license_id);
CREATE INDEX idx_license_change_requests_school_requested_by
  ON app.license_change_requests (school_id, requested_by);

-- ---------------------------------------------------------------------------------------------------
-- 5. Stopping an AI add-on's renewal
-- ---------------------------------------------------------------------------------------------------

-- The app.subscriptions column (000087) for the per-student add-on. Set when a school seat covers a
-- student who pays for the add-on: Stripe also gets cancel_at_period_end, Google Play a cancel, and
-- the Tap renewal worker -- which is what renews a Tap add-on -- lets the period end instead of
-- charging the saved card.
ALTER TABLE app.ai_subscriptions
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;

-- Which of these students bought the add-on in an app store, and its store reference. An App Store
-- or Google Play add-on has no provider column on app.ai_subscriptions: it is linked to the student
-- only through the purchase's billing event (modules/subscriptions/store/service.ts, findClaim),
-- and app.billing_events is studafy_admin-only. SECURITY DEFINER, limited to the armed school's own
-- events and returning nothing but the platform and the store reference, so the seat flow can tell
-- an Apple purchase (notify the student) from a Google one (cancel through the Play API).
CREATE FUNCTION app.ai_store_purchases(target_student_ids uuid[])
RETURNS TABLE (student_id uuid, platform text, store_ref text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT DISTINCT ON (be.payload -> 'metadata' ->> 'student_id')
    (be.payload -> 'metadata' ->> 'student_id')::uuid,
    be.provider,
    be.payload ->> 'store_ref'
  FROM app.billing_events AS be
  WHERE be.provider IN ('apple', 'google')
    AND be.status = 'processed'
    AND be.payload ->> 'store_ref' IS NOT NULL
    AND be.payload -> 'metadata' ->> 'school_id' = current_setting('app.school_id')
    AND be.payload -> 'metadata' ->> 'student_id' IN (
      SELECT ids.id::text FROM unnest(target_student_ids) AS ids (id)
    )
  ORDER BY be.payload -> 'metadata' ->> 'student_id', be.effective_at DESC
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 6. Privileges and tenant isolation
-- ---------------------------------------------------------------------------------------------------

-- No DELETE anywhere: licenses end by status, seats by unassigned_at, credits and requests are
-- records.
REVOKE ALL PRIVILEGES ON TABLE
  app.school_licenses, app.license_seats, app.license_seat_overlaps, app.license_change_requests
FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE
  app.school_licenses, app.license_seats, app.license_seat_overlaps, app.license_change_requests
TO studafy_app;

REVOKE ALL ON FUNCTION
  app.school_licenses_check_tiers(),
  app.license_seat_eligible(text, uuid, uuid),
  app.license_seats_before_insert(),
  app.license_seats_before_update(),
  app.school_licenses_check_assigned(),
  app.ai_store_purchases(uuid[])
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.license_seat_eligible(text, uuid, uuid),
  app.ai_store_purchases(uuid[])
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'school_licenses');
SELECT app.apply_tenant_isolation('app', 'license_seats');
SELECT app.apply_tenant_isolation('app', 'license_seat_overlaps');
SELECT app.apply_tenant_isolation('app', 'license_change_requests');

COMMENT ON TABLE app.school_licenses IS
  'A school''s feature license: a tier and seat count per audience, a period and a status. At most one active per school.';
COMMENT ON TABLE app.license_seats IS
  'Seats assigned to people on a license. Capacity and eligibility are enforced by trg_license_seats_before_insert.';
COMMENT ON TABLE app.license_seat_overlaps IS
  'Seats given to people who already pay personally: the overlap credit owed to the school and the renewal action taken.';
COMMENT ON TABLE app.license_change_requests IS
  'A school''s request to the super admin for different seat counts or Family+.';
COMMENT ON COLUMN app.ai_subscriptions.cancel_at_period_end IS
  'Renewal is off: the add-on ends at current_period_end. Set when a school seat covers the student.';

RESET ROLE;
