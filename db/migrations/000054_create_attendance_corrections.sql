-- Attendance corrections (ST-109). Teachers and principals amend previously submitted
-- attendance records; every amendment is preserved in an immutable version chain.
--
-- Two parts:
--   1. app.attendance_records gains a `version` counter and a candidate key that includes the
--      partition column, so a version row can reference an individual record.
--   2. app.attendance_record_versions records one row per correction, holding the before/after
--      status pair, the mandatory justification, the acting user, and whether the correction was
--      an out-of-window administrative override.
--
-- The version chain is append-only for the app role: studafy_app receives SELECT and INSERT
-- only, never UPDATE or DELETE. This mirrors app.grading_schemes (000053) and app.audit_logs
-- (000018). Note that 000002 installs ALTER DEFAULT PRIVILEGES granting studafy_app full DML on
-- every table studafy_admin creates in app, so the REVOKE below is load-bearing rather than
-- decorative.
--
-- Why attendance_record_versions is NOT partitioned, unlike its parent: a correction is a rare
-- event relative to a record, so the table does not need the monthly range partitioning that
-- app.attendance_records carries for volume. Staying unpartitioned also keeps
-- app.create_attendance_partitions (and packages/db/src/partitions.ts) unchanged, which would
-- otherwise need a third forward amendment to install role_scope_visibility on every future
-- monthly leaf. The per-row cost of the foreign key into the partitioned parent -- roughly 12x
-- an ordinary reference, measured in 000012 -- is paid once per correction rather than 40 times
-- per batch, and is not material at that rate.
--
-- Why student_id is carried here rather than reached through attendance_record_id: the
-- role_scope_visibility policy below must call app.can_read_student(), and a policy expression
-- cannot cheaply join to a partitioned table. This is the same structural duplication that
-- 000012 accepts for attendance_records.session_created_at, and for the same reason.

-- app.attendance_records has forced RLS. Its new UNIQUE constraint builds an index over every
-- existing partition; set a non-matching tenant context so the scan can execute without
-- weakening RLS, following 000053.
SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- 1. Version counter and record-level candidate key on the partitioned parent

ALTER TABLE app.attendance_records
  ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE app.attendance_records
  ADD CONSTRAINT ck_attendance_records_version
    CHECK (version >= 1);

-- Mirrors uq_attendance_sessions_id_school_created. A unique constraint on a partitioned table
-- must contain every partitioning column, hence created_at. Leading with id also gives the
-- correction and history endpoints a way to find a single record across all partitions, which
-- no existing index provides.
ALTER TABLE app.attendance_records
  ADD CONSTRAINT uq_attendance_records_id_school_created
    UNIQUE (id, school_id, created_at);

COMMENT ON COLUMN app.attendance_records.version IS
  'Correction generation. 1 when first recorded; incremented by each correction, which also '
  'appends the matching row to app.attendance_record_versions.';

-- 2. The immutable correction chain

CREATE TABLE app.attendance_record_versions (
  id                    uuid DEFAULT gen_random_uuid()
                        CONSTRAINT pk_attendance_record_versions PRIMARY KEY,
  school_id             uuid NOT NULL,
  attendance_record_id  uuid NOT NULL,
  -- timestamptz(3), not timestamptz: this participates in a foreign key that compares the
  -- partition column for equality, and postgres 3.4.9 transports bound timestamps at
  -- millisecond precision. See the note at the head of 000012.
  record_created_at     timestamptz(3) NOT NULL,
  student_id            uuid NOT NULL,
  version               integer NOT NULL,
  previous_status       app.attendance_status NOT NULL,
  new_status            app.attendance_status NOT NULL,
  previous_minutes_late smallint,
  new_minutes_late      smallint,
  reason                text NOT NULL,
  corrected_by_user_id  uuid NOT NULL,
  out_of_window         boolean NOT NULL DEFAULT false,
  corrected_at          timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- The version chain index the correction history reads: one row per generation per record,
  -- ascending. Unique rather than a plain index because two corrections may not claim the same
  -- generation of the same record.
  CONSTRAINT uq_attendance_record_versions_chain
    UNIQUE (school_id, attendance_record_id, version),

  CONSTRAINT fk_attendance_record_versions_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_attendance_record_versions_record
    FOREIGN KEY (attendance_record_id, school_id, record_created_at)
    REFERENCES app.attendance_records (id, school_id, created_at)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_attendance_record_versions_student
    FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_attendance_record_versions_corrected_by
    FOREIGN KEY (corrected_by_user_id, school_id)
    REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  -- Generation 1 is the record as first submitted; it is reconstructed from the record itself
  -- and the earliest chain row, never stored. Every stored row is therefore a correction.
  CONSTRAINT ck_attendance_record_versions_version
    CHECK (version >= 2),

  CONSTRAINT ck_attendance_record_versions_changed
    CHECK (
      previous_status <> new_status
      OR previous_minutes_late IS DISTINCT FROM new_minutes_late
    ),

  CONSTRAINT ck_attendance_record_versions_reason
    CHECK (reason = btrim(reason) AND reason <> '' AND char_length(reason) <= 500),

  CONSTRAINT ck_attendance_record_versions_previous_minutes_late
    CHECK (
      previous_minutes_late IS NULL
      OR (previous_minutes_late >= 0 AND previous_status = 'late')
    ),

  CONSTRAINT ck_attendance_record_versions_new_minutes_late
    CHECK (
      new_minutes_late IS NULL
      OR (new_minutes_late >= 0 AND new_status = 'late')
    )
);

-- Per-student correction reporting: "what has been amended for this student, most recent first".
CREATE INDEX idx_attendance_record_versions_school_student
  ON app.attendance_record_versions (school_id, student_id, corrected_at DESC);

REVOKE ALL PRIVILEGES ON TABLE app.attendance_record_versions FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT ON TABLE app.attendance_record_versions TO studafy_app;
-- No UPDATE or DELETE: the correction chain is immutable once written.

SELECT app.apply_tenant_isolation('app', 'attendance_record_versions');

-- Intra-tenant row scope, matching what 000037 installs on app.attendance_records. The tenant
-- boundary above answers "which school"; this answers "which students within it".
CREATE POLICY role_scope_visibility ON app.attendance_record_versions
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(student_id));

RESET ROLE;
