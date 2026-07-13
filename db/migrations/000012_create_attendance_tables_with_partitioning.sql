-- Creates the school-owned attendance model: attendance_sessions (one attendance-taking event for a
-- class on a business date) and attendance_records (one normalized row per student outcome in that
-- session). Both are declaratively range-partitioned by month on created_at -- attendance is the
-- highest-volume table in the product, and monthly partitions keep vacuum, index maintenance, and
-- history queries bounded. See docs/database/attendance.md for the full design note and
-- docs/database/attendance-partition-maintenance.md for the operational runbook.
--
-- Three consequences of partitioning are handled explicitly here rather than papered over:
--
-- 1. app.apply_tenant_isolation (000006) rejects any relation whose relkind is not 'r'. A partitioned
--    parent is relkind 'p', so the helper is forward-amended below to accept 'p' as well. The rest of
--    its contract is unchanged. 000006 itself is applied and immutable; it is never edited.
--
-- 2. RLS does not cascade. ENABLE/FORCE ROW LEVEL SECURITY on a partitioned parent does not recurse
--    to its partitions, and a parent policy is not consulted when a partition is queried directly.
--    studafy_app can name a partition directly, so every leaf gets its own ENABLE + FORCE + canonical
--    tenant_isolation policy, applied by app.create_attendance_partitions at creation time.
--
-- 3. PostgreSQL can only enforce a UNIQUE constraint on a partitioned table if the constraint includes
--    the partition key. The real business keys (one session per class/date/period; one record per
--    session/student) do not include created_at, so they CANNOT be enforced on these tables. They are
--    enforced instead on two small unpartitioned registry tables, kept in step by row triggers. A
--    duplicate therefore still raises 23505 from the database, not from application code.
--
-- The attendance timestamps are timestamptz(3), not the bare timestamptz used elsewhere in the schema.
-- These are the only timestamps in Studafy that a foreign key compares for equality: referencing a row
-- in a partitioned table requires carrying that table's partition key, so attendance_records must hold
-- the session's created_at exactly. PostgreSQL stores timestamptz at microsecond precision, but the
-- repository's driver (postgres 3.4.9) transports a bound timestamp parameter at millisecond
-- precision, so a microsecond value cannot survive an application round-trip and the foreign key
-- would never match. Pinning the stored precision to milliseconds makes the round-trip exact by
-- construction instead of relying on every caller to avoid the trap. Milliseconds are ample for an
-- audit and partition-routing timestamp, and id remains a UUID, so no key loses its discriminating
-- power. Partition boundaries are unaffected.

SET ROLE studafy_admin;

-- Forward amendment of the canonical ST-034 helper. Body is identical to 000006 except that the
-- relation-kind guard now admits partitioned tables ('p') alongside ordinary tables ('r'); every other
-- precondition (schema, global-table denylist, studafy_admin ownership, school_id type/NOT NULL, the
-- single-column FK to app.schools, no competing permissive policy, byte-compatible existing policy) is
-- preserved. Partitions are ordinary tables and were already accepted.
CREATE OR REPLACE FUNCTION app.apply_tenant_isolation(
  target_schema name,
  target_table name
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_oid oid;
  target_kind "char";
  target_owner oid;
  admin_oid oid;
  schools_oid oid;
  school_id_attnum smallint;
  school_id_type oid;
  school_id_typmod integer;
  school_id_not_null boolean;
  canonical_attnum smallint;
  canonical_type oid;
  canonical_typmod integer;
  canonical_policy record;
  canonical_policy_found boolean;
  normalized_using text;
  normalized_check text;
  expected_expression text := 'school_id=current_setting''app.school_id''::uuid';
BEGIN
  IF target_schema IS NULL OR pg_catalog.btrim(target_schema::text) = ''
     OR target_table IS NULL OR pg_catalog.btrim(target_table::text) = '' THEN
    RAISE EXCEPTION 'target schema and table names must be non-empty'
      USING ERRCODE = '22023';
  END IF;

  IF target_schema::text <> 'app' THEN
    RAISE EXCEPTION 'tenant isolation may only be applied to tables in schema app, got %.%',
      target_schema, target_table
      USING ERRCODE = '22023';
  END IF;

  SELECT c.oid, c.relkind, c.relowner
  INTO target_oid, target_kind, target_owner
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = target_schema::text
    AND c.relname = target_table::text;

  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'target table %.% does not exist', target_schema, target_table
      USING ERRCODE = '42P01';
  END IF;

  IF target_kind NOT IN ('r', 'p') THEN
    RAISE EXCEPTION
      'target %.% must be an ordinary or partitioned table; relation kind is %',
      target_schema, target_table, target_kind
      USING ERRCODE = '42809';
  END IF;

  IF target_table::text IN (
    'schools',
    'plans',
    'plan_prices',
    'countries',
    'currencies',
    'platform_settings'
  ) THEN
    RAISE EXCEPTION 'global table %.% cannot receive tenant isolation', target_schema, target_table
      USING ERRCODE = '22023';
  END IF;

  SELECT r.oid INTO admin_oid
  FROM pg_catalog.pg_roles AS r
  WHERE r.rolname = 'studafy_admin';

  IF target_owner <> admin_oid THEN
    RAISE EXCEPTION 'tenant table %.% must be owned by studafy_admin, not %',
      target_schema, target_table, pg_catalog.pg_get_userbyid(target_owner)
      USING ERRCODE = '42501';
  END IF;

  SELECT c.oid INTO schools_oid
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = 'schools' AND c.relkind = 'r';

  SELECT a.attnum, a.atttypid, a.atttypmod
  INTO canonical_attnum, canonical_type, canonical_typmod
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = schools_oid
    AND a.attname = 'id'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  SELECT a.attnum, a.atttypid, a.atttypmod, a.attnotnull
  INTO school_id_attnum, school_id_type, school_id_typmod, school_id_not_null
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = target_oid
    AND a.attname = 'school_id'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF school_id_attnum IS NULL THEN
    RAISE EXCEPTION 'tenant table %.% must contain school_id', target_schema, target_table
      USING ERRCODE = '42703';
  END IF;

  IF school_id_type <> canonical_type OR school_id_typmod <> canonical_typmod THEN
    RAISE EXCEPTION '%.%.school_id type % must match app.schools.id type %',
      target_schema,
      target_table,
      pg_catalog.format_type(school_id_type, school_id_typmod),
      pg_catalog.format_type(canonical_type, canonical_typmod)
      USING ERRCODE = '42804';
  END IF;

  IF NOT school_id_not_null THEN
    RAISE EXCEPTION 'tenant table %.%.school_id must be NOT NULL', target_schema, target_table
      USING ERRCODE = '23502';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS con
    WHERE con.conrelid = target_oid
      AND con.contype = 'f'
      AND con.confrelid = schools_oid
      AND con.conkey = ARRAY[school_id_attnum]::smallint[]
      AND con.confkey = ARRAY[canonical_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION '%.%.school_id must have a single-column foreign key to app.schools(id)',
      target_schema, target_table
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS p
    WHERE p.polrelid = target_oid
      AND p.polname <> 'tenant_isolation'
      AND p.polpermissive
  ) THEN
    RAISE EXCEPTION 'table %.% has another permissive policy that could broaden tenant access',
      target_schema, target_table
      USING ERRCODE = '22023';
  END IF;

  SELECT
    p.polcmd,
    p.polpermissive,
    p.polroles,
    pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using_expression,
    pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
  INTO canonical_policy
  FROM pg_catalog.pg_policy AS p
  WHERE p.polrelid = target_oid
    AND p.polname = 'tenant_isolation';
  canonical_policy_found := FOUND;

  IF canonical_policy_found THEN
    normalized_using := pg_catalog.regexp_replace(
      pg_catalog.replace(canonical_policy.using_expression, '::text', ''),
      '[[:space:]()]',
      '',
      'g'
    );
    normalized_check := pg_catalog.regexp_replace(
      pg_catalog.replace(canonical_policy.check_expression, '::text', ''),
      '[[:space:]()]',
      '',
      'g'
    );

    IF canonical_policy.polcmd <> '*'
       OR NOT canonical_policy.polpermissive
       OR canonical_policy.polroles <> ARRAY[0::oid]
       OR normalized_using <> expected_expression
       OR normalized_check <> expected_expression THEN
      RAISE EXCEPTION 'existing tenant_isolation policy on %.% is incompatible',
        target_schema, target_table
        USING ERRCODE = '22023';
    END IF;
  END IF;

  EXECUTE pg_catalog.format(
    'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
    target_schema,
    target_table
  );
  EXECUTE pg_catalog.format(
    'ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
    target_schema,
    target_table
  );

  IF NOT canonical_policy_found THEN
    EXECUTE pg_catalog.format(
      'CREATE POLICY tenant_isolation ON %I.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (school_id = current_setting(''app.school_id'')::uuid) '
      'WITH CHECK (school_id = current_setting(''app.school_id'')::uuid)',
      target_schema,
      target_table
    );
  END IF;
END
$function$;

ALTER FUNCTION app.apply_tenant_isolation(name, name) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.apply_tenant_isolation(name, name) FROM PUBLIC, studafy_app;
GRANT EXECUTE ON FUNCTION app.apply_tenant_isolation(name, name) TO studafy_admin;

CREATE TYPE app.attendance_session_status AS ENUM (
  'draft', 'open', 'submitted', 'locked', 'cancelled'
);
CREATE TYPE app.attendance_status AS ENUM ('present', 'absent', 'late', 'excused', 'remote');

-- One attendance-taking event for one class. session_date is the educational business date and is the
-- column attendance is queried by; created_at is the audit/partition-routing timestamp and is never a
-- substitute for it (a school in UTC+9 taking Monday's attendance, or an import backfilled weeks
-- later, would both land on the wrong business day if created_at were reused as the date).
--
-- period matches the opaque school-defined ordinal on app.timetable_slots.period. NULL means the
-- school takes attendance once per class per day rather than per timetable period; the business key in
-- app.attendance_session_keys treats NULLs as equal, so either regime allows exactly one session.
--
-- The primary key is (id, created_at) because PostgreSQL requires the partition key in every unique
-- constraint on a partitioned table. id alone is therefore NOT enforced unique across partitions; it
-- is a gen_random_uuid() surrogate, so a collision is not a practical risk, but the database does not
-- guarantee it and this migration does not claim that it does.
CREATE TABLE app.attendance_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  class_id uuid NOT NULL,
  session_date date NOT NULL,
  period smallint,
  status app.attendance_session_status NOT NULL DEFAULT 'draft',
  taken_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_attendance_sessions PRIMARY KEY (id, created_at),
  -- The partition-key-inclusive analogue of the house uq_<table>_id_school candidate key. It is what
  -- makes (id, school_id, created_at) a tenant-checked identity for a session, and it backs the
  -- pruned lookup of one session by id.
  CONSTRAINT uq_attendance_sessions_id_school_created UNIQUE (id, school_id, created_at),
  CONSTRAINT fk_attendance_sessions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_sessions_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_sessions_taken_by FOREIGN KEY (taken_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_attendance_sessions_period CHECK (period IS NULL OR period > 0),
  CONSTRAINT ck_attendance_sessions_timestamps CHECK (updated_at >= created_at)
) PARTITION BY RANGE (created_at);

-- The two registries below exist because they are unpartitioned, so PostgreSQL can enforce on them the
-- keys it cannot enforce on a partitioned table. They store keys, never attributes -- no status, no
-- notes, no denormalized class or student data -- so they add no new source of truth. Only the two
-- SECURITY DEFINER trigger functions further down ever write them; studafy_app holds SELECT and
-- nothing else.

-- One row per attendance session, maintained 1:1 with app.attendance_sessions by trigger.
--
-- UNIQUE NULLS NOT DISTINCT makes a NULL period (daily attendance) collide with another NULL period,
-- so "one session per class per day" holds for daily schools and "one session per class, day and
-- period" holds for period-based schools, without a sentinel value.
--
-- uq_attendance_session_keys_session is the session's stable, unpartitioned identity, and is the
-- foreign-key target for app.attendance_records below.
CREATE TABLE app.attendance_session_keys (
  school_id uuid NOT NULL,
  class_id uuid NOT NULL,
  session_date date NOT NULL,
  period smallint,
  attendance_session_id uuid NOT NULL,
  session_created_at timestamptz(3) NOT NULL,
  CONSTRAINT uq_attendance_session_keys_business_key
    UNIQUE NULLS NOT DISTINCT (school_id, class_id, session_date, period),
  CONSTRAINT uq_attendance_session_keys_session
    UNIQUE (school_id, attendance_session_id, session_created_at),
  CONSTRAINT fk_attendance_session_keys_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_attendance_session_keys_period CHECK (period IS NULL OR period > 0)
);

-- One student's outcome in one session. No class_id and no attendance_date: both are functionally
-- dependent on attendance_session_id and would be 3NF-violating copies. The class/date access path
-- starts at app.attendance_sessions, which carries the required (school_id, class_id, session_date)
-- index; record queries join down from a session.
--
-- fk_attendance_records_session references app.attendance_session_keys, not app.attendance_sessions
-- directly, and that is deliberate:
--
--   * Referencing the partitioned table itself is possible -- a unique constraint containing the
--     partition key exists for exactly that purpose -- but every referential check against a
--     partitioned table costs roughly twelve times one against an ordinary table. Measured on the
--     development container, that single foreign key accounted for 15 ms of a 19 ms 40-record batch,
--     and the cost is per row, so it is paid on every roster ever submitted. (It is flat in the number
--     of partitions: 8 partitions and 44 partitions cost the same. The overhead is per-check, not a
--     pruning failure.)
--   * The registry is a faithful image of the session: the trigger keeps it 1:1, and no role other
--     than the trigger can write it. So "a row exists in attendance_session_keys with this
--     (school_id, attendance_session_id, session_created_at)" is true exactly when the corresponding
--     session row exists. The guarantee is identical; only the physical target differs.
--   * Deleting a session deletes its registry row, which this foreign key then blocks (RESTRICT) if
--     any record still references it -- the same protection a direct reference would give.
--
-- session_created_at is the one deliberate structural duplication. It pins the record to a specific
-- session row (not merely a reused id), keeps the reference tenant-checked, and lets a join back to
-- app.attendance_sessions constrain the partition key and prune to a single monthly partition instead
-- of probing all of them.
CREATE TABLE app.attendance_records (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  attendance_session_id uuid NOT NULL,
  session_created_at timestamptz(3) NOT NULL,
  student_id uuid NOT NULL,
  status app.attendance_status NOT NULL,
  minutes_late smallint,
  reason text,
  recorded_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_attendance_records PRIMARY KEY (id, created_at),
  CONSTRAINT fk_attendance_records_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_records_session
    FOREIGN KEY (school_id, attendance_session_id, session_created_at)
    REFERENCES app.attendance_session_keys (school_id, attendance_session_id, session_created_at)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_records_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_records_recorded_by FOREIGN KEY (recorded_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_attendance_records_minutes_late CHECK (
    minutes_late IS NULL OR (minutes_late >= 0 AND status = 'late')
  ),
  CONSTRAINT ck_attendance_records_reason CHECK (
    reason IS NULL OR (reason = btrim(reason) AND reason <> '')
  ),
  CONSTRAINT ck_attendance_records_timestamps CHECK (updated_at >= created_at)
) PARTITION BY RANGE (created_at);

-- One row per (session, student). This is the constraint that makes "a student cannot be marked twice
-- in the same session" true, including when the two records would land in different monthly partitions.
-- Its primary key is the business key, so the trigger locates a row by it and no second index is
-- needed; attendance_record_id and record_created_at are carried for traceability back to the record.
CREATE TABLE app.attendance_record_keys (
  school_id uuid NOT NULL,
  attendance_session_id uuid NOT NULL,
  student_id uuid NOT NULL,
  attendance_record_id uuid NOT NULL,
  record_created_at timestamptz(3) NOT NULL,
  CONSTRAINT pk_attendance_record_keys
    PRIMARY KEY (school_id, attendance_session_id, student_id),
  CONSTRAINT fk_attendance_record_keys_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Keeps app.attendance_session_keys in step with app.attendance_sessions. Runs AFTER the row so the
-- session already exists; a duplicate business key surfaces as 23505 on the registry's unique
-- constraint and aborts the session insert with it. Row triggers on a partitioned table are cloned to
-- every partition, so this fires for direct partition writes too. A cross-partition UPDATE of
-- created_at is executed by PostgreSQL as DELETE + INSERT, which this handles as such.
--
-- SECURITY DEFINER, because the registries are the only enforcement of the attendance business keys
-- and must not be writable by anything else. studafy_app holds SELECT on them and nothing more: a
-- runtime role that could INSERT into a registry could park a row on a class/date and permanently
-- block a legitimate session, and one that could DELETE from it could then write the duplicate the
-- registry exists to prevent. Only these two trigger functions write there. Tenant isolation is
-- unaffected -- the registries still force RLS, and studafy_admin is subject to it like any other
-- role, so the row this writes must still satisfy the tenant policy.
CREATE FUNCTION app.sync_attendance_session_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM app.attendance_session_keys
    WHERE school_id = OLD.school_id
      AND attendance_session_id = OLD.id
      AND session_created_at = OLD.created_at;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.attendance_session_keys (
      school_id, class_id, session_date, period, attendance_session_id, session_created_at
    ) VALUES (
      NEW.school_id, NEW.class_id, NEW.session_date, NEW.period, NEW.id, NEW.created_at
    );
    RETURN NEW;
  END IF;

  UPDATE app.attendance_session_keys
  SET school_id = NEW.school_id,
      class_id = NEW.class_id,
      session_date = NEW.session_date,
      period = NEW.period,
      session_created_at = NEW.created_at
  WHERE school_id = OLD.school_id
    AND attendance_session_id = OLD.id
    AND session_created_at = OLD.created_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance session % has no business-key registry row', OLD.id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END
$function$;

-- Keeps app.attendance_record_keys in step with app.attendance_records. Same shape and same reasoning
-- as app.sync_attendance_session_key, including SECURITY DEFINER.
CREATE FUNCTION app.sync_attendance_record_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM app.attendance_record_keys
    WHERE school_id = OLD.school_id
      AND attendance_session_id = OLD.attendance_session_id
      AND student_id = OLD.student_id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.attendance_record_keys (
      school_id, attendance_session_id, student_id, attendance_record_id, record_created_at
    ) VALUES (
      NEW.school_id, NEW.attendance_session_id, NEW.student_id, NEW.id, NEW.created_at
    );
    RETURN NEW;
  END IF;

  UPDATE app.attendance_record_keys
  SET school_id = NEW.school_id,
      attendance_session_id = NEW.attendance_session_id,
      student_id = NEW.student_id,
      attendance_record_id = NEW.id,
      record_created_at = NEW.created_at
  WHERE school_id = OLD.school_id
    AND attendance_session_id = OLD.attendance_session_id
    AND student_id = OLD.student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance record % has no business-key registry row', OLD.id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_attendance_sessions_sync_business_key
AFTER INSERT
   OR UPDATE OF school_id, class_id, session_date, period, created_at
   OR DELETE
ON app.attendance_sessions
FOR EACH ROW EXECUTE FUNCTION app.sync_attendance_session_key();

CREATE TRIGGER trg_attendance_records_sync_business_key
AFTER INSERT
   OR UPDATE OF school_id, attendance_session_id, student_id, created_at
   OR DELETE
ON app.attendance_records
FOR EACH ROW EXECUTE FUNCTION app.sync_attendance_record_key();

ALTER FUNCTION app.sync_attendance_session_key() OWNER TO studafy_admin;
ALTER FUNCTION app.sync_attendance_record_key() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.sync_attendance_session_key() FROM PUBLIC, studafy_app;
REVOKE ALL ON FUNCTION app.sync_attendance_record_key() FROM PUBLIC, studafy_app;

-- Indexes are declared on the partitioned parents. PostgreSQL creates a matching partition-local index
-- on every existing partition and on every partition attached later, so app.create_attendance_partitions
-- never creates indexes itself and no index is ever declared twice.

-- The required leading attendance index: the attendance session for a class on a date, and a class's
-- sessions over a date range. Trailing id makes ordering deterministic for pagination.
CREATE INDEX idx_attendance_sessions_school_class_date
  ON app.attendance_sessions (school_id, class_id, session_date, id);
-- Backs the taken_by_user_id foreign key's parent-delete check and "sessions taken by this teacher".
CREATE INDEX idx_attendance_sessions_school_taken_by
  ON app.attendance_sessions (school_id, taken_by_user_id);

-- The roster read ("all records for this session") and the batch-write conflict lookup. Its
-- (school_id, attendance_session_id) prefix also backs the session foreign key's parent-delete check.
CREATE INDEX idx_attendance_records_school_session_student
  ON app.attendance_records (school_id, attendance_session_id, student_id);
-- One student's attendance history, newest first. Constrains created_at, so it prunes partitions. Its
-- (school_id, student_id) prefix also backs the student foreign key's parent-delete check.
CREATE INDEX idx_attendance_records_school_student_created
  ON app.attendance_records (school_id, student_id, created_at DESC, id);
-- Backs the recorded_by_user_id foreign key's parent-delete check.
CREATE INDEX idx_attendance_records_school_recorded_by
  ON app.attendance_records (school_id, recorded_by_user_id);

-- The registries' own unique constraints index every column a trigger looks a row up by; no further
-- index is needed on either of them.

REVOKE ALL PRIVILEGES ON TABLE
  app.attendance_sessions, app.attendance_records,
  app.attendance_session_keys, app.attendance_record_keys
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.attendance_sessions, app.attendance_records
TO studafy_app;
-- Read-only on the registries. They are derived key state, written exclusively by the two SECURITY
-- DEFINER trigger functions above; the runtime role may read them (to pre-check a conflict before
-- attempting a write) but may never author or remove a key. The explicit REVOKE is required: the
-- default privileges established in 000002 grant studafy_app INSERT/UPDATE/DELETE on every table
-- studafy_admin creates in this schema, so granting SELECT alone would leave the write rights in place.
REVOKE ALL PRIVILEGES ON TABLE app.attendance_session_keys, app.attendance_record_keys
FROM studafy_app;
GRANT SELECT ON TABLE app.attendance_session_keys, app.attendance_record_keys TO studafy_app;

REVOKE ALL ON TYPE app.attendance_session_status, app.attendance_status FROM PUBLIC;
GRANT USAGE ON TYPE app.attendance_session_status, app.attendance_status TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'attendance_sessions');
SELECT app.apply_tenant_isolation('app', 'attendance_records');
SELECT app.apply_tenant_isolation('app', 'attendance_session_keys');
SELECT app.apply_tenant_isolation('app', 'attendance_record_keys');

-- Creates the monthly partition of both attendance parents for the month containing target_month, and
-- returns the names it created (empty when both already existed). Administrative DDL: SECURITY INVOKER
-- and granted only to studafy_admin, so the runtime role cannot reach it even though it can write
-- attendance rows.
--
-- Month boundaries are UTC and half-open, [first instant of the month, first instant of the next):
-- the function pins timezone = 'UTC' for its own duration so a partition's bounds never depend on the
-- server's or the caller's TimeZone setting. Business attendance dates are a separate concept
-- (attendance_sessions.session_date) and are unaffected by this choice.
--
-- Idempotent: an existing partition whose bounds already match is left alone. Anything else occupying
-- the name -- a table that is not a partition of this parent, or a partition with different bounds --
-- raises rather than being silently altered, because rewriting a live partition's bounds would either
-- lose rows or fail halfway.
--
-- There is deliberately no DEFAULT partition. A default partition would silently absorb rows for a
-- month whose partition maintenance had failed, turning a loud, immediately fixable error into an
-- unbounded heap discovered months later.
CREATE FUNCTION app.create_attendance_partitions(target_month date)
RETURNS text[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET timezone = 'UTC'
AS $function$
DECLARE
  month_start timestamptz;
  month_end timestamptz;
  parent text;
  partition_name text;
  created text[] := ARRAY[]::text[];
  existing_oid oid;
  existing_kind "char";
  existing_parent oid;
  existing_bounds text;
  expected_bounds text;
BEGIN
  IF target_month IS NULL THEN
    RAISE EXCEPTION 'target month must not be null' USING ERRCODE = '22023';
  END IF;

  month_start := pg_catalog.date_trunc('month', target_month::timestamptz);
  month_end := month_start + INTERVAL '1 month';
  expected_bounds := pg_catalog.format('FOR VALUES FROM (%L) TO (%L)', month_start, month_end);

  FOREACH parent IN ARRAY ARRAY['attendance_sessions', 'attendance_records'] LOOP
    partition_name := pg_catalog.format(
      '%s_y%sm%s',
      parent,
      pg_catalog.to_char(month_start, 'YYYY'),
      pg_catalog.to_char(month_start, 'MM')
    );

    SELECT c.oid, c.relkind, i.inhparent
    INTO existing_oid, existing_kind, existing_parent
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_inherits AS i ON i.inhrelid = c.oid
    WHERE n.nspname = 'app' AND c.relname = partition_name;

    IF existing_oid IS NOT NULL THEN
      IF existing_kind <> 'r'
         OR existing_parent IS DISTINCT FROM pg_catalog.to_regclass('app.' || pg_catalog.quote_ident(parent))::oid THEN
        RAISE EXCEPTION 'app.% already exists and is not a partition of app.%',
          partition_name, parent
          USING ERRCODE = '42P07';
      END IF;

      SELECT pg_catalog.pg_get_expr(c.relpartbound, c.oid)
      INTO existing_bounds
      FROM pg_catalog.pg_class AS c
      WHERE c.oid = existing_oid;

      IF pg_catalog.regexp_replace(existing_bounds, '[[:space:]]', '', 'g')
         <> pg_catalog.regexp_replace(expected_bounds, '[[:space:]]', '', 'g') THEN
        RAISE EXCEPTION
          'existing partition app.% has bounds % but % were requested; refusing to alter it',
          partition_name, existing_bounds, expected_bounds
          USING ERRCODE = '42P17';
      END IF;

      CONTINUE;
    END IF;

    EXECUTE pg_catalog.format(
      'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
      partition_name, parent, month_start, month_end
    );
    -- Default privileges (000002) would already grant studafy_app CRUD on a table studafy_admin
    -- creates in app; these are stated anyway so a partition's grants do not depend on a setting made
    -- three migrations ago and are identical whether the partition was made here or by hand.
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE app.%I FROM PUBLIC', partition_name);
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.%I TO studafy_app',
      partition_name
    );
    -- A partition is directly nameable by studafy_app and does not inherit the parent's policy, so it
    -- gets its own ENABLE + FORCE + canonical tenant_isolation here. Without this line every new
    -- partition would be a tenant-isolation hole.
    PERFORM app.apply_tenant_isolation('app', partition_name);

    created := created || partition_name;
  END LOOP;

  RETURN created;
END
$function$;

-- Creates every missing monthly partition from the current UTC month through months_ahead months
-- later. This is what the scheduled maintenance job calls; it is safe to run repeatedly and returns
-- the names it actually created so the job can log them.
CREATE FUNCTION app.ensure_attendance_partitions(months_ahead integer DEFAULT 3)
RETURNS text[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
SET timezone = 'UTC'
AS $function$
DECLARE
  created text[] := ARRAY[]::text[];
  month_offset integer;
BEGIN
  IF months_ahead IS NULL OR months_ahead < 0 OR months_ahead > 24 THEN
    RAISE EXCEPTION 'months_ahead must be between 0 and 24, got %', months_ahead
      USING ERRCODE = '22023';
  END IF;

  FOR month_offset IN 0..months_ahead LOOP
    created := created || app.create_attendance_partitions(
      (pg_catalog.date_trunc('month', CURRENT_TIMESTAMP)
        + pg_catalog.make_interval(months => month_offset))::date
    );
  END LOOP;

  RETURN created;
END
$function$;

ALTER FUNCTION app.create_attendance_partitions(date) OWNER TO studafy_admin;
ALTER FUNCTION app.ensure_attendance_partitions(integer) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.create_attendance_partitions(date) FROM PUBLIC, studafy_app;
REVOKE ALL ON FUNCTION app.ensure_attendance_partitions(integer) FROM PUBLIC, studafy_app;
GRANT EXECUTE ON FUNCTION app.create_attendance_partitions(date) TO studafy_admin;
GRANT EXECUTE ON FUNCTION app.ensure_attendance_partitions(integer) TO studafy_admin;

-- The initial partition range is written out as fixed months rather than derived from CURRENT_DATE so
-- that this migration is deterministic: the same file must produce the same schema whenever it is
-- applied, and its checksum is immutable. ST-040 was authored in 2026-07, so this covers the previous
-- month, the current month, and six months ahead. Beyond 2027-01 the rolling horizon is the
-- maintenance job's responsibility -- see docs/database/attendance-partition-maintenance.md. A
-- database first migrated after 2027-01 has no usable attendance partition until that job has run
-- once, and an insert will fail loudly (23514) until it does.
SELECT app.create_attendance_partitions('2026-06-01');
SELECT app.create_attendance_partitions('2026-07-01');
SELECT app.create_attendance_partitions('2026-08-01');
SELECT app.create_attendance_partitions('2026-09-01');
SELECT app.create_attendance_partitions('2026-10-01');
SELECT app.create_attendance_partitions('2026-11-01');
SELECT app.create_attendance_partitions('2026-12-01');
SELECT app.create_attendance_partitions('2027-01-01');

RESET ROLE;
