-- Creates the school-owned timetable model: draft/pending/approved timetable_versions and the
-- timetable_slots they contain (class, teacher, room, weekday, period). A version is a whole
-- proposed weekly schedule for one term; only one version per term may ever be 'approved'. Slots may
-- only be written while their version is 'draft', so an approved schedule is immutable history and a
-- pending one is frozen for review. Double-booking is prevented structurally, not by application
-- code: two EXCLUDE constraints reject a teacher or a room being scheduled twice in the same version
-- at the same weekday/period. See docs/database/timetable-model.md for the full design note.

-- btree_gist supplies GiST support for the scalar equality operators (=) used by the EXCLUDE
-- constraints below; without it PostgreSQL has no GiST opclass for uuid/smallint equality and
-- EXCLUDE USING gist cannot be declared. Same ownership rule as 000003: installing an extension
-- requires superuser, so this stays with the connecting migration-runner identity, never
-- studafy_admin (NOSUPERUSER). See docs/database/extensions.md.
CREATE EXTENSION IF NOT EXISTS btree_gist;

SET ROLE studafy_admin;

CREATE TYPE app.timetable_version_status AS ENUM ('draft', 'pending', 'approved');

-- One weekly-schedule proposal for one school term. submitted_at/submitted_by_user_id and
-- approved_at/approved_by_user_id are set only by app.enforce_timetable_version_transition (never
-- trusted from client input) and their presence is pinned to status by
-- ck_timetable_versions_submission_state, so the approval state machine cannot be left inconsistent
-- by any write path.
CREATE TABLE app.timetable_versions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_timetable_versions PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  term_id uuid NOT NULL,
  name text NOT NULL,
  status app.timetable_version_status NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  submitted_by_user_id uuid,
  approved_at timestamptz,
  approved_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_timetable_versions_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_timetable_versions_school_term_name UNIQUE (school_id, term_id, name),
  CONSTRAINT fk_timetable_versions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_versions_academic_year FOREIGN KEY (academic_year_id, school_id)
    REFERENCES app.academic_years (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_versions_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_versions_submitted_by FOREIGN KEY (submitted_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_versions_approved_by FOREIGN KEY (approved_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_timetable_versions_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_timetable_versions_submission_state CHECK (
    (
      status = 'draft'
      AND submitted_at IS NULL AND submitted_by_user_id IS NULL
      AND approved_at IS NULL AND approved_by_user_id IS NULL
    ) OR (
      status = 'pending'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND approved_at IS NULL AND approved_by_user_id IS NULL
    ) OR (
      status = 'approved'
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
      AND approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL
      AND approved_at >= submitted_at
    )
  ),
  CONSTRAINT ck_timetable_versions_timestamps CHECK (updated_at >= created_at)
);

-- One weekly-recurring occurrence of a class: who teaches it, where, and when. teacher_id and
-- room_id are independent of app.classes.lead_teacher_id/room_id (a slot may use a substitute
-- teacher or an overflow room), so both are stated explicitly rather than derived.
CREATE TABLE app.timetable_slots (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_timetable_slots PRIMARY KEY,
  school_id uuid NOT NULL,
  timetable_version_id uuid NOT NULL,
  class_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  room_id uuid NOT NULL,
  weekday smallint NOT NULL,
  period smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_timetable_slots_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_slots_version FOREIGN KEY (timetable_version_id, school_id)
    REFERENCES app.timetable_versions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_slots_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_slots_teacher FOREIGN KEY (teacher_id, school_id)
    REFERENCES app.teachers (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_timetable_slots_room FOREIGN KEY (room_id, school_id)
    REFERENCES app.rooms (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_timetable_slots_weekday CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT ck_timetable_slots_period CHECK (period > 0),
  CONSTRAINT ck_timetable_slots_timestamps CHECK (updated_at >= created_at),
  -- "Overlap" here is two slots claiming the same weekday/period in the same version: with no
  -- period durations in the model (see docs/database/timetable-model.md), collision is equality,
  -- not range overlap, but is still expressed as EXCLUDE (not UNIQUE) so a future duration/range
  -- column extends these same two constraints instead of replacing them.
  CONSTRAINT ex_timetable_slots_teacher_weekday_period EXCLUDE USING gist (
    school_id WITH =,
    timetable_version_id WITH =,
    teacher_id WITH =,
    weekday WITH =,
    period WITH =
  ),
  CONSTRAINT ex_timetable_slots_room_weekday_period EXCLUDE USING gist (
    school_id WITH =,
    timetable_version_id WITH =,
    room_id WITH =,
    weekday WITH =,
    period WITH =
  )
);

-- Enforces the timetable_versions approval state machine (draft -> pending -> approved, or
-- pending -> draft to send a submission back). Timestamps/actors are written here, from the
-- session's own statement values, never accepted verbatim from an update that skips a state, and
-- the four audit columns cannot be touched by any update that does not also change status.
CREATE FUNCTION app.enforce_timetable_version_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a new timetable version must start in draft status, got %', NEW.status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id THEN
      RAISE EXCEPTION
        'submission/approval audit columns can only change together with a status transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'pending' THEN
    IF NEW.submitted_by_user_id IS NULL THEN
      RAISE EXCEPTION 'submitting a timetable version requires submitted_by_user_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := CURRENT_TIMESTAMP;
    NEW.approved_at := NULL;
    NEW.approved_by_user_id := NULL;
  ELSIF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    IF NEW.approved_by_user_id IS NULL THEN
      RAISE EXCEPTION 'approving a timetable version requires approved_by_user_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by_user_id := OLD.submitted_by_user_id;
    NEW.approved_at := CURRENT_TIMESTAMP;
  ELSIF OLD.status = 'pending' AND NEW.status = 'draft' THEN
    NEW.submitted_at := NULL;
    NEW.submitted_by_user_id := NULL;
    NEW.approved_at := NULL;
    NEW.approved_by_user_id := NULL;
  ELSE
    RAISE EXCEPTION 'invalid timetable version transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

-- A slot's class must belong to the same term/year as the timetable version it is scheduled in;
-- otherwise a Spring class could silently end up inside a Fall draft. Mirrors the
-- enforce_term_within_academic_year lock-then-check pattern from 000009.
CREATE FUNCTION app.enforce_timetable_slot_class_term()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  version_term_id uuid;
  version_academic_year_id uuid;
  class_term_id uuid;
  class_academic_year_id uuid;
BEGIN
  SELECT term_id, academic_year_id
  INTO version_term_id, version_academic_year_id
  FROM app.timetable_versions
  WHERE id = NEW.timetable_version_id AND school_id = NEW.school_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'timetable version % does not belong to school %',
      NEW.timetable_version_id, NEW.school_id USING ERRCODE = '23503';
  END IF;

  SELECT term_id, academic_year_id
  INTO class_term_id, class_academic_year_id
  FROM app.classes
  WHERE id = NEW.class_id AND school_id = NEW.school_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not belong to school %', NEW.class_id, NEW.school_id
      USING ERRCODE = '23503';
  END IF;

  IF class_term_id <> version_term_id OR class_academic_year_id <> version_academic_year_id THEN
    RAISE EXCEPTION
      'class % (term %) does not match timetable version % (term %)',
      NEW.class_id, class_term_id, NEW.timetable_version_id, version_term_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

-- Slots may only be inserted, updated, or deleted while their version is 'draft'. Without this, an
-- 'approved' schedule (or one 'pending' review) could still be edited underneath the approval it
-- represents, which would defeat the point of the state machine above.
CREATE FUNCTION app.enforce_timetable_slot_version_editable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  row_school_id uuid;
  row_version_id uuid;
  version_status app.timetable_version_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_school_id := OLD.school_id;
    row_version_id := OLD.timetable_version_id;
  ELSE
    row_school_id := NEW.school_id;
    row_version_id := NEW.timetable_version_id;
  END IF;

  SELECT status INTO version_status
  FROM app.timetable_versions
  WHERE id = row_version_id AND school_id = row_school_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'timetable version % does not belong to school %',
      row_version_id, row_school_id USING ERRCODE = '23503';
  END IF;

  IF version_status <> 'draft' THEN
    RAISE EXCEPTION
      'timetable slots can only change while their version is draft, version % is %',
      row_version_id, version_status USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_timetable_versions_transition
BEFORE INSERT OR UPDATE OF
  status, submitted_at, submitted_by_user_id, approved_at, approved_by_user_id
ON app.timetable_versions
FOR EACH ROW EXECUTE FUNCTION app.enforce_timetable_version_transition();

CREATE TRIGGER trg_timetable_slots_class_matches_version_term
BEFORE INSERT OR UPDATE OF class_id, timetable_version_id, school_id ON app.timetable_slots
FOR EACH ROW EXECUTE FUNCTION app.enforce_timetable_slot_class_term();

CREATE TRIGGER trg_timetable_slots_version_editable
BEFORE INSERT OR UPDATE OR DELETE ON app.timetable_slots
FOR EACH ROW EXECUTE FUNCTION app.enforce_timetable_slot_version_editable();

ALTER FUNCTION app.enforce_timetable_version_transition() OWNER TO studafy_admin;
ALTER FUNCTION app.enforce_timetable_slot_class_term() OWNER TO studafy_admin;
ALTER FUNCTION app.enforce_timetable_slot_version_editable() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.enforce_timetable_version_transition() FROM PUBLIC, studafy_app;
REVOKE ALL ON FUNCTION app.enforce_timetable_slot_class_term() FROM PUBLIC, studafy_app;
REVOKE ALL ON FUNCTION app.enforce_timetable_slot_version_editable() FROM PUBLIC, studafy_app;

-- Only one approved version may exist per term at a time; retrieving it is also the primary
-- "what is the live schedule" lookup.
CREATE UNIQUE INDEX uq_timetable_versions_one_approved_per_term
  ON app.timetable_versions (school_id, term_id) WHERE status = 'approved';
CREATE INDEX idx_timetable_versions_school_academic_year_id
  ON app.timetable_versions (school_id, academic_year_id, id);
CREATE INDEX idx_timetable_versions_school_term_id
  ON app.timetable_versions (school_id, term_id, id);
CREATE INDEX idx_timetable_versions_school_submitted_by
  ON app.timetable_versions (school_id, submitted_by_user_id);
CREATE INDEX idx_timetable_versions_school_approved_by
  ON app.timetable_versions (school_id, approved_by_user_id);

-- The two EXCLUDE constraints above already index (school_id, timetable_version_id, teacher_id, ...)
-- and (school_id, timetable_version_id, room_id, ...), covering their own FK parent-delete checks
-- and "this version's teacher/room schedule" lookups. idx_timetable_slots_school_version_id backs
-- the version FK and the "render one version's whole timetable" query; idx_timetable_slots_school_class_id
-- backs the class FK and "this class's weekly periods" query.
CREATE INDEX idx_timetable_slots_school_version_id
  ON app.timetable_slots (school_id, timetable_version_id, id);
CREATE INDEX idx_timetable_slots_school_class_id
  ON app.timetable_slots (school_id, class_id, id);

REVOKE ALL PRIVILEGES ON TABLE app.timetable_versions, app.timetable_slots FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.timetable_versions, app.timetable_slots TO studafy_app;

REVOKE ALL ON TYPE app.timetable_version_status FROM PUBLIC;
GRANT USAGE ON TYPE app.timetable_version_status TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'timetable_versions');
SELECT app.apply_tenant_isolation('app', 'timetable_slots');

RESET ROLE;
