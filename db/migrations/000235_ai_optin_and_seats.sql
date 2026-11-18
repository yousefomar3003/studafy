-- Student AI opt-in and programme seats: phase 2 of "Student AI seats bundled with tuition, plus
-- revenue share" (approved 2026-11-17; docs/billing/ai-programme.md).
--
-- A school opens an opt-in window for an academic year (optionally for some grades or sections
-- only). While it is open, a parent ticks "Student AI for <child>" in the app -- committed for the
-- rest of the school's academic year, paid with tuition, never cancelled mid-year -- or the school
-- records the choice on the parent's behalf. Every opted-in student gets a seat on the school's
-- licence through the ordinary seat model (app.license_seats, migration 000163), so Student AI
-- unlocks through the existing entitlement path.
--
-- ## Tables
--
--   * app.ai_optin_windows        -- a window: the licence it fills, the academic year, the dates it
--                                    is open (school-local), who opened and who closed it.
--   * app.ai_optin_window_scopes  -- the grades or sections a window is limited to (no rows: every
--                                    enrolled student of the year).
--   * app.ai_optins               -- one student's opt-in: who confirmed it (the parent, or the
--                                    school on the parent's behalf, or a seat transferred from a
--                                    student who left), when, under which terms version, the months
--                                    it covers (start month to the academic year's last month), the
--                                    price parents see per month and the total, the seat it holds,
--                                    and how it ended (released from a month, or transferred).
--   * app.ai_optin_window_notices -- the workers' record of "Student AI is available for <child>"
--                                    notices, one per (window, student).
--
-- ## Rules the database keeps
--
--   * One open (not closed) window per school; dates in order.
--   * One active opt-in per student per academic year.
--   * An opt-in never goes back: status moves only from active to released or transferred, once;
--     the seat is linked once; nothing else about it changes, and it is never deleted
--     (trg_ai_optins_guard). A parent cannot undo it: only school leadership may end one
--     (ai_optins_end_scope, restrictive UPDATE policy).
--   * A programme seat is not unassigned while its opt-in is active
--     (trg_license_seats_programme_lock, ck_license_seats_programme_locked): the school transfers or
--     releases the opt-in first (only for a student who has left the school).
--   * Reads: tenant isolation, and within the school leadership sees every opt-in while a parent (or
--     the student) sees only their own child's (role_scope_visibility, app.is_related_to_student).
--
-- ## Licences and quotes: commitment
--
-- school_licenses.commitment and license_quotes.commitment: 'full_year' (the whole academic year,
-- cannot be cancelled; earns the revenue share) or 'month_to_month' (cancellable; earns
-- month_to_month_share_bps of the tiers, 0% by default -- phase 5). Every existing licence and quote
-- was sold as a fixed term with no way to cancel it, so they are 'full_year'. A new licence or an
-- extension takes the accepted quote's commitment; a seat increase keeps the licence's.
--
-- ## Seats the programme needs
--
-- license_change_requests.source: 'school' (asked by the school) or 'ai_optin' (opened by Studafy
-- when opt-ins need more seats than the licence has: the larger of the opt-ins and the programme's
-- minimum seats). At most one open 'ai_optin' request per licence, raised as more students opt in;
-- the super admin prices it as a seat-increase quote like any other request.
--
-- Depends on 000008 (students, parent links), 000009 (academic years), 000037 (scope helpers),
-- 000147 (grade levels, sections), 000163 (licences, seats, change requests), 000165 (quotes).

-- The FK validation scans below read app.school_licenses and app.license_quotes, which force RLS: a
-- non-matching tenant context lets them run (as in 000168 and 000233).
SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Commitment on licences and quotes; the source of a change request
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.school_licenses
  ADD COLUMN commitment text NOT NULL DEFAULT 'full_year',
  ADD CONSTRAINT ck_school_licenses_commitment CHECK (commitment IN ('full_year', 'month_to_month'));

ALTER TABLE app.license_quotes
  ADD COLUMN commitment text NOT NULL DEFAULT 'full_year',
  ADD CONSTRAINT ck_license_quotes_commitment CHECK (commitment IN ('full_year', 'month_to_month'));

COMMENT ON COLUMN app.school_licenses.commitment IS
  'full_year: the whole academic year, cannot be cancelled; month_to_month: cancellable (000235).';
COMMENT ON COLUMN app.license_quotes.commitment IS
  'The commitment the licence is signed with when this quote is accepted (new or extension) (000235).';

ALTER TABLE app.license_change_requests
  ADD COLUMN source text NOT NULL DEFAULT 'school',
  ADD CONSTRAINT ck_license_change_requests_source CHECK (source IN ('school', 'ai_optin'));

CREATE UNIQUE INDEX uq_license_change_requests_open_ai_optin
  ON app.license_change_requests (school_id, license_id)
  WHERE source = 'ai_optin' AND status = 'open';

COMMENT ON COLUMN app.license_change_requests.source IS
  'school: asked by the school; ai_optin: opened by Studafy because Student AI opt-ins need more seats (000235).';

-- ---------------------------------------------------------------------------------------------------
-- 2. Windows
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_optin_windows (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_optin_windows PRIMARY KEY,
  school_id uuid NOT NULL,
  license_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  -- School-local dates, both included.
  opens_on date NOT NULL,
  closes_on date NOT NULL,
  note text,
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at timestamptz,
  closed_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ai_optin_windows_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_ai_optin_windows_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optin_windows_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optin_windows_academic_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optin_windows_opened_by FOREIGN KEY (opened_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optin_windows_closed_by FOREIGN KEY (closed_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_optin_windows_dates CHECK (closes_on >= opens_on),
  CONSTRAINT ck_ai_optin_windows_closed CHECK ((closed_at IS NULL) = (closed_by IS NULL)),
  CONSTRAINT ck_ai_optin_windows_note CHECK (
    note IS NULL OR (note = btrim(note) AND note <> '' AND char_length(note) <= 1000)
  ),
  CONSTRAINT ck_ai_optin_windows_timestamps CHECK (updated_at >= created_at)
);

-- One window not yet closed per school (a window past its end date is closed when the next opens).
CREATE UNIQUE INDEX uq_ai_optin_windows_one_open
  ON app.ai_optin_windows (school_id) WHERE closed_at IS NULL;
CREATE INDEX idx_ai_optin_windows_school_year
  ON app.ai_optin_windows (school_id, academic_year_id, opened_at DESC);
CREATE INDEX idx_ai_optin_windows_school_license ON app.ai_optin_windows (school_id, license_id);
CREATE INDEX idx_ai_optin_windows_school_opened_by ON app.ai_optin_windows (school_id, opened_by);
CREATE INDEX idx_ai_optin_windows_school_closed_by
  ON app.ai_optin_windows (school_id, closed_by) WHERE closed_by IS NOT NULL;

CREATE TABLE app.ai_optin_window_scopes (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_optin_window_scopes PRIMARY KEY,
  school_id uuid NOT NULL,
  window_id uuid NOT NULL,
  grade_level_id uuid,
  section_id uuid,
  CONSTRAINT fk_ai_optin_window_scopes_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optin_window_scopes_window FOREIGN KEY (window_id, school_id)
    REFERENCES app.ai_optin_windows (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optin_window_scopes_grade FOREIGN KEY (grade_level_id, school_id)
    REFERENCES app.grade_levels (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optin_window_scopes_section FOREIGN KEY (section_id, school_id)
    REFERENCES app.sections (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_optin_window_scopes_one CHECK ((grade_level_id IS NULL) <> (section_id IS NULL))
);

CREATE UNIQUE INDEX uq_ai_optin_window_scopes_grade
  ON app.ai_optin_window_scopes (school_id, window_id, grade_level_id)
  WHERE grade_level_id IS NOT NULL;
CREATE UNIQUE INDEX uq_ai_optin_window_scopes_section
  ON app.ai_optin_window_scopes (school_id, window_id, section_id)
  WHERE section_id IS NOT NULL;
CREATE INDEX idx_ai_optin_window_scopes_school_grade
  ON app.ai_optin_window_scopes (school_id, grade_level_id) WHERE grade_level_id IS NOT NULL;
CREATE INDEX idx_ai_optin_window_scopes_school_section
  ON app.ai_optin_window_scopes (school_id, section_id) WHERE section_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- 3. Opt-ins
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_optins (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_optins PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  license_id uuid NOT NULL,
  -- The window it was taken in; NULL for a seat transferred from a student who left.
  window_id uuid,
  -- parent: the parent confirmed it in the app; school_on_behalf: school leadership recorded the
  -- parent's choice (with a note); transfer: the seat of a student who left, given to this student.
  source text NOT NULL,
  -- The parent who confirmed it (source parent).
  parent_user_id uuid,
  -- Who wrote it: the parent, or the school admin / principal.
  recorded_by uuid NOT NULL,
  note text,
  -- The terms the parent agreed to (AI_OPTIN_TERMS_VERSION in @studafy/constants).
  terms_version text NOT NULL,
  opted_in_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- First and last month covered (first days of months): from the month it was taken (or the
  -- academic year's first month, if earlier) to the academic year's last month.
  start_month date NOT NULL,
  end_month date NOT NULL,
  months integer NOT NULL,
  -- What parents see, in the licence's currency: per month, and months x that.
  currency_id uuid NOT NULL,
  monthly_price_minor bigint NOT NULL,
  total_minor bigint NOT NULL,
  -- The licence seat it holds; NULL while it waits for the licence to have a free seat.
  seat_id uuid,
  seat_assigned_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  ended_at timestamptz,
  ended_by uuid,
  end_note text,
  -- released: the first month it is no longer charged (the month after the release).
  released_effective_month date,
  -- transferred: the opt-in the seat went to; transfer: the one it came from.
  transferred_to_id uuid,
  transferred_from_id uuid,
  -- When school leadership was told about it (the workers' daily summary).
  admins_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ai_optins_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_ai_optins_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_academic_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_license FOREIGN KEY (license_id, school_id)
    REFERENCES app.school_licenses (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_window FOREIGN KEY (window_id, school_id)
    REFERENCES app.ai_optin_windows (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_parent FOREIGN KEY (parent_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_recorded_by FOREIGN KEY (recorded_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_ended_by FOREIGN KEY (ended_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_currency FOREIGN KEY (currency_id)
    REFERENCES app.currencies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_seat FOREIGN KEY (seat_id, school_id)
    REFERENCES app.license_seats (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_transferred_to FOREIGN KEY (transferred_to_id, school_id)
    REFERENCES app.ai_optins (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optins_transferred_from FOREIGN KEY (transferred_from_id, school_id)
    REFERENCES app.ai_optins (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_optins_source CHECK (
    CASE source
      WHEN 'parent' THEN parent_user_id IS NOT NULL AND window_id IS NOT NULL
        AND transferred_from_id IS NULL
      WHEN 'school_on_behalf' THEN parent_user_id IS NULL AND window_id IS NOT NULL
        AND note IS NOT NULL AND transferred_from_id IS NULL
      WHEN 'transfer' THEN parent_user_id IS NULL AND note IS NOT NULL
        AND transferred_from_id IS NOT NULL
      ELSE false
    END
  ),
  CONSTRAINT ck_ai_optins_note CHECK (
    note IS NULL OR (note = btrim(note) AND note <> '' AND char_length(note) <= 1000)
  ),
  CONSTRAINT ck_ai_optins_terms_version CHECK (
    terms_version = btrim(terms_version) AND terms_version <> '' AND char_length(terms_version) <= 40
  ),
  CONSTRAINT ck_ai_optins_months CHECK (
    start_month = date_trunc('month', start_month)::date
    AND end_month = date_trunc('month', end_month)::date
    AND end_month >= start_month
    AND months = (EXTRACT(YEAR FROM end_month)::integer * 12 + EXTRACT(MONTH FROM end_month)::integer)
               - (EXTRACT(YEAR FROM start_month)::integer * 12 + EXTRACT(MONTH FROM start_month)::integer) + 1
  ),
  CONSTRAINT ck_ai_optins_price CHECK (
    monthly_price_minor >= 0 AND total_minor = monthly_price_minor * months
  ),
  CONSTRAINT ck_ai_optins_seat CHECK ((seat_id IS NULL) = (seat_assigned_at IS NULL)),
  CONSTRAINT ck_ai_optins_status CHECK (
    CASE status
      WHEN 'active' THEN ended_at IS NULL AND ended_by IS NULL AND end_note IS NULL
        AND released_effective_month IS NULL AND transferred_to_id IS NULL
      WHEN 'released' THEN ended_at IS NOT NULL AND ended_by IS NOT NULL AND end_note IS NOT NULL
        AND released_effective_month = date_trunc('month', released_effective_month)::date
        AND transferred_to_id IS NULL
      WHEN 'transferred' THEN ended_at IS NOT NULL AND ended_by IS NOT NULL AND end_note IS NOT NULL
        AND released_effective_month IS NULL AND transferred_to_id IS NOT NULL
      ELSE false
    END
  ),
  CONSTRAINT ck_ai_optins_end_note CHECK (
    end_note IS NULL OR (end_note = btrim(end_note) AND end_note <> '' AND char_length(end_note) <= 1000)
  ),
  CONSTRAINT ck_ai_optins_timestamps CHECK (updated_at >= created_at)
);

-- One active opt-in per student per academic year.
CREATE UNIQUE INDEX uq_ai_optins_active_student_year
  ON app.ai_optins (school_id, student_id, academic_year_id) WHERE status = 'active';
-- A seat belongs to one opt-in.
CREATE UNIQUE INDEX uq_ai_optins_seat ON app.ai_optins (school_id, seat_id) WHERE seat_id IS NOT NULL;
-- A licence's opt-ins (counts, seats waiting) and the licence foreign key.
CREATE INDEX idx_ai_optins_school_license ON app.ai_optins (school_id, license_id, status, opted_in_at);
CREATE INDEX idx_ai_optins_school_year ON app.ai_optins (school_id, academic_year_id, status);
CREATE INDEX idx_ai_optins_school_student ON app.ai_optins (school_id, student_id);
CREATE INDEX idx_ai_optins_school_window ON app.ai_optins (school_id, window_id) WHERE window_id IS NOT NULL;
CREATE INDEX idx_ai_optins_school_parent
  ON app.ai_optins (school_id, parent_user_id) WHERE parent_user_id IS NOT NULL;
CREATE INDEX idx_ai_optins_school_recorded_by ON app.ai_optins (school_id, recorded_by);
CREATE INDEX idx_ai_optins_school_ended_by ON app.ai_optins (school_id, ended_by) WHERE ended_by IS NOT NULL;
CREATE INDEX idx_ai_optins_currency ON app.ai_optins (currency_id);
CREATE INDEX idx_ai_optins_school_transferred_to
  ON app.ai_optins (school_id, transferred_to_id) WHERE transferred_to_id IS NOT NULL;
CREATE INDEX idx_ai_optins_school_transferred_from
  ON app.ai_optins (school_id, transferred_from_id) WHERE transferred_from_id IS NOT NULL;
-- The workers' daily summary to school leadership.
CREATE INDEX idx_ai_optins_school_unnotified
  ON app.ai_optins (school_id, opted_in_at) WHERE admins_notified_at IS NULL;

-- An opt-in is a commitment: it is never deleted, and only these changes are allowed, once each --
-- the seat is linked; status leaves 'active' (released or transferred) with who, when, why; the
-- workers mark leadership notified.
CREATE FUNCTION app.ai_optins_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a Student AI opt-in is never deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_ai_optins_immutable',
            TABLE = 'ai_optins', SCHEMA = 'app';
  END IF;

  IF (NEW.id, NEW.school_id, NEW.student_id, NEW.academic_year_id, NEW.license_id, NEW.window_id,
      NEW.source, NEW.parent_user_id, NEW.recorded_by, NEW.note, NEW.terms_version, NEW.opted_in_at,
      NEW.start_month, NEW.end_month, NEW.months, NEW.currency_id, NEW.monthly_price_minor,
      NEW.total_minor, NEW.transferred_from_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.school_id, OLD.student_id, OLD.academic_year_id, OLD.license_id, OLD.window_id,
      OLD.source, OLD.parent_user_id, OLD.recorded_by, OLD.note, OLD.terms_version, OLD.opted_in_at,
      OLD.start_month, OLD.end_month, OLD.months, OLD.currency_id, OLD.monthly_price_minor,
      OLD.total_minor, OLD.transferred_from_id, OLD.created_at)
     -- The seat is linked once and stays.
     OR (OLD.seat_id IS NOT NULL AND NEW.seat_id IS DISTINCT FROM OLD.seat_id)
     OR (OLD.seat_assigned_at IS NOT NULL AND NEW.seat_assigned_at IS DISTINCT FROM OLD.seat_assigned_at)
     -- Status leaves 'active' once, and an ended opt-in never changes again.
     OR (OLD.status <> 'active' AND (NEW.status, NEW.ended_at, NEW.ended_by, NEW.end_note,
         NEW.released_effective_month, NEW.transferred_to_id)
         IS DISTINCT FROM (OLD.status, OLD.ended_at, OLD.ended_by, OLD.end_note,
         OLD.released_effective_month, OLD.transferred_to_id))
     OR (OLD.admins_notified_at IS NOT NULL AND NEW.admins_notified_at IS DISTINCT FROM OLD.admins_notified_at)
  THEN
    RAISE EXCEPTION 'a Student AI opt-in cannot be changed or undone'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_ai_optins_immutable',
            TABLE = 'ai_optins', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_ai_optins_guard
  BEFORE UPDATE OR DELETE ON app.ai_optins
  FOR EACH ROW EXECUTE FUNCTION app.ai_optins_guard();

-- The seat an active opt-in holds stays assigned: transfer or release the opt-in first.
CREATE FUNCTION app.license_seats_programme_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.unassigned_at IS NULL AND NEW.unassigned_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.ai_optins AS o
    WHERE o.school_id = OLD.school_id AND o.seat_id = OLD.id AND o.status = 'active'
  ) THEN
    RAISE EXCEPTION 'seat % holds an active Student AI opt-in: transfer or release it instead', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_seats_programme_locked',
            TABLE = 'license_seats', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_license_seats_programme_lock
  BEFORE UPDATE OF unassigned_at ON app.license_seats
  FOR EACH ROW EXECUTE FUNCTION app.license_seats_programme_lock();

-- ---------------------------------------------------------------------------------------------------
-- 4. The workers' notices
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_optin_window_notices (
  school_id uuid NOT NULL,
  window_id uuid NOT NULL,
  student_id uuid NOT NULL,
  recipients integer NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_ai_optin_window_notices PRIMARY KEY (school_id, window_id, student_id),
  CONSTRAINT fk_ai_optin_window_notices_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optin_window_notices_window FOREIGN KEY (window_id, school_id)
    REFERENCES app.ai_optin_windows (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_optin_window_notices_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_optin_window_notices_recipients CHECK (recipients >= 0)
);

CREATE INDEX idx_ai_optin_window_notices_school_student
  ON app.ai_optin_window_notices (school_id, student_id);

-- ---------------------------------------------------------------------------------------------------
-- 5. Who reads what
-- ---------------------------------------------------------------------------------------------------

-- Leadership sees every opt-in of the school; a parent (or the student) only their own child's.
-- SECURITY DEFINER for the reason given in 000037 (the helpers read tables with their own policies).
CREATE FUNCTION app.can_read_ai_optin(target_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin() OR app.is_related_to_student(target_student_id)
$function$;

-- Whether an active opt-in holds a seat: the generic unassign refuses such a seat before trying.
CREATE FUNCTION app.ai_optin_seat_locked(target_seat_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM app.ai_optins AS o
    WHERE o.school_id = current_setting('app.school_id')::uuid
      AND o.seat_id = target_seat_id
      AND o.status = 'active'
  )
$function$;

-- A licence's active opt-ins and how many wait for a seat: what sizes its seat request. Counts only,
-- so a parent's opt-in (which sees only their own child's rows) can size it for the whole school.
CREATE FUNCTION app.ai_optin_license_counts(target_license_id uuid)
RETURNS TABLE (active integer, waiting integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT count(*)::integer, (count(*) FILTER (WHERE o.seat_id IS NULL))::integer
  FROM app.ai_optins AS o
  WHERE o.school_id = current_setting('app.school_id')::uuid
    AND o.license_id = target_license_id
    AND o.status = 'active'
$function$;

REVOKE ALL PRIVILEGES ON TABLE
  app.ai_optin_windows, app.ai_optin_window_scopes, app.ai_optins, app.ai_optin_window_notices
FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.ai_optin_windows, app.ai_optins TO studafy_app;
GRANT SELECT, INSERT ON TABLE app.ai_optin_window_scopes TO studafy_app;
GRANT SELECT ON TABLE app.ai_optin_window_notices TO studafy_app;

REVOKE ALL ON FUNCTION app.ai_optins_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.license_seats_programme_lock() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.can_read_ai_optin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.ai_optin_seat_locked(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.ai_optin_license_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.can_read_ai_optin(uuid), app.ai_optin_seat_locked(uuid), app.ai_optin_license_counts(uuid)
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'ai_optin_windows');
SELECT app.apply_tenant_isolation('app', 'ai_optin_window_scopes');
SELECT app.apply_tenant_isolation('app', 'ai_optins');
SELECT app.apply_tenant_isolation('app', 'ai_optin_window_notices');

CREATE POLICY role_scope_visibility ON app.ai_optins
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_ai_optin(student_id));

-- Only leadership ends an opt-in (release or transfer). Anyone else -- a parent's own request, the
-- seat being linked -- may only touch a row that stays active.
CREATE POLICY ai_optins_end_scope ON app.ai_optins
  AS RESTRICTIVE FOR UPDATE TO studafy_app
  USING (app.current_user_is_school_admin() OR status = 'active')
  WITH CHECK (app.current_user_is_school_admin() OR status = 'active');

COMMENT ON TABLE app.ai_optin_windows IS
  'Student AI opt-in windows: the licence, academic year and school-local dates parents may opt in (000235).';
COMMENT ON TABLE app.ai_optin_window_scopes IS
  'The grades or sections a Student AI opt-in window is limited to; none means every enrolled student (000235).';
COMMENT ON TABLE app.ai_optins IS
  'One student''s Student AI opt-in for an academic year: who, when, terms, months, price, seat, and how it ended (000235).';
COMMENT ON TABLE app.ai_optin_window_notices IS
  'The workers'' "Student AI is available" notices, one per window and student (000235).';

RESET ROLE;
