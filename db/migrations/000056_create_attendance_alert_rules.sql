-- Attendance alert engine (ST-110). Per-school absence thresholds, and the append-only log that
-- guarantees a parent is told about a given breach exactly once.
--
-- Two tables:
--   1. app.attendance_alert_rules  -- school-level configuration. Which thresholds are armed.
--   2. app.attendance_alert_logs   -- one row per (student, parent, breach). Both the audit trail
--                                     and the deduplication arbiter.
--
-- The dedup design is the load-bearing part. A BullMQ job can be retried, enqueued twice, or run
-- concurrently on two worker processes, and the acceptance criterion is zero duplicate alerts. That
-- is enforced by uq_attendance_alert_logs_dedup and an INSERT ... ON CONFLICT DO NOTHING that the
-- worker treats as a claim: a returned row means "you own this alert, send it", no row means
-- "someone already did". The unique index is the arbiter, not application logic -- which is what
-- makes it correct under concurrency rather than merely usually correct. This follows the repo's
-- established idiom (app.erpnext_webhook_dedup, 000027); there are no Redis locks anywhere in this
-- codebase and this does not introduce the first.
--
-- Note what is IN that unique key: parent_user_id. One breach fans out to every linked parent, so
-- keying on (school_id, student_id, dedup_key) alone would let the first parent's row swallow the
-- second parent's insert, and that second parent would silently never be told. The dedup unit is
-- the notification, not the breach.

SET ROLE studafy_admin;

CREATE TYPE app.attendance_alert_rule_type AS ENUM ('consecutive_days', 'period_count');

-- 1. Rule configuration

CREATE TABLE app.attendance_alert_rules (
  id              uuid DEFAULT gen_random_uuid()
                    CONSTRAINT pk_attendance_alert_rules PRIMARY KEY,
  school_id       uuid NOT NULL,
  rule_type       app.attendance_alert_rule_type NOT NULL,
  threshold_value smallint NOT NULL,
  -- period_count only: how many days back to count over. NULL for consecutive_days, which is
  -- inherently anchored to the triggering date and needs no window.
  window_days     smallint,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One rule per type per school. A school that wants two consecutive-day thresholds wants two
  -- alerts, which is a product decision nobody has made; until then this keeps evaluation
  -- deterministic and the dedup key unambiguous.
  CONSTRAINT uq_attendance_alert_rules_school_type UNIQUE (school_id, rule_type),

  CONSTRAINT fk_attendance_alert_rules_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_attendance_alert_rules_threshold
    CHECK (threshold_value BETWEEN 1 AND 365),

  CONSTRAINT ck_attendance_alert_rules_window
    CHECK (
      CASE rule_type
        WHEN 'period_count' THEN window_days IS NOT NULL AND window_days BETWEEN 1 AND 365
        ELSE window_days IS NULL
      END
    ),

  CONSTRAINT ck_attendance_alert_rules_timestamps
    CHECK (updated_at >= created_at)
);

-- The worker's first query on every job: the armed rules for one school.
CREATE INDEX idx_attendance_alert_rules_school_active
  ON app.attendance_alert_rules (school_id, is_active);

-- 2. Alert log / dedup ledger

CREATE TABLE app.attendance_alert_logs (
  id              uuid DEFAULT gen_random_uuid()
                    CONSTRAINT pk_attendance_alert_logs PRIMARY KEY,
  school_id       uuid NOT NULL,
  student_id      uuid NOT NULL,
  parent_user_id  uuid NOT NULL,
  rule_type       app.attendance_alert_rule_type NOT NULL,
  threshold_value smallint NOT NULL,
  -- '<rule_type>:<threshold_value>:<boundary_date>'. School, student and parent are columns of
  -- this table and deliberately stay out of the string rather than being repeated inside it. The
  -- threshold is part of the key on purpose: raising a school's bar is a new alerting condition
  -- and legitimately re-arms the alert.
  dedup_key       text NOT NULL,
  -- The BullMQ job that claimed this alert. Correlation for support, not a foreign key -- the
  -- queue is not a relation and its jobs are evicted on the retention policy.
  trigger_job_id  text,
  -- Set immediately after the notification row is written. Nullable because the claim is taken
  -- first: a crash between claim and notify leaves a visible orphan rather than a duplicate.
  notification_id uuid,
  sent_at         timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_attendance_alert_logs_dedup
    UNIQUE (school_id, student_id, parent_user_id, dedup_key),

  CONSTRAINT fk_attendance_alert_logs_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_attendance_alert_logs_student
    FOREIGN KEY (student_id, school_id) REFERENCES app.students (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_attendance_alert_logs_parent
    FOREIGN KEY (parent_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_attendance_alert_logs_notification
    FOREIGN KEY (notification_id, school_id) REFERENCES app.notifications (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_attendance_alert_logs_threshold
    CHECK (threshold_value BETWEEN 1 AND 365),

  CONSTRAINT ck_attendance_alert_logs_dedup_key
    CHECK (
      dedup_key = btrim(dedup_key) AND dedup_key <> '' AND char_length(dedup_key) <= 200
    )
);

-- "What has this student been alerted about, most recent first" -- the support and reporting path.
CREATE INDEX idx_attendance_alert_logs_school_student_sent
  ON app.attendance_alert_logs (school_id, student_id, sent_at DESC);

-- Grants.
--
-- 000002 installs ALTER DEFAULT PRIVILEGES granting studafy_app full DML on every table
-- studafy_admin creates in app, so the REVOKE below is load-bearing rather than decoration. The
-- log is append-only for the same reason app.audit_logs and app.attendance_record_versions are: a
-- record of what was sent that can be edited is not a record. UPDATE is the one exception --
-- notification_id is stamped after the claim -- so it is granted, unlike on audit_logs, and DELETE
-- is not.
REVOKE ALL PRIVILEGES ON TABLE app.attendance_alert_logs FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.attendance_alert_logs TO studafy_app;

REVOKE ALL ON TYPE app.attendance_alert_rule_type FROM PUBLIC;
GRANT USAGE ON TYPE app.attendance_alert_rule_type TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'attendance_alert_rules');
SELECT app.apply_tenant_isolation('app', 'attendance_alert_logs');

-- Intra-tenant row scope on the log, matching what 000037 installs on app.attendance_records: the
-- tenant boundary answers "which school", this answers "which students within it", so a teacher
-- cannot read alerts about a student they have no claim on. attendance_alert_rules carries no
-- student column and is school-level configuration, so it needs the tenant boundary only -- the
-- same shape as app.school_settings.
CREATE POLICY role_scope_visibility ON app.attendance_alert_logs
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(student_id));

-- The absence window the alert engine evaluates.
--
-- SECURITY DEFINER, and that is the point. app.attendance_records carries a role_scope_visibility
-- policy calling app.can_read_student(), which resolves the acting user from app.user_id. The
-- alert worker is an unattended process with no acting user, so under studafy_app it would read
-- zero rows and silently never alert -- the worst possible failure for this feature, because it
-- looks exactly like "nobody was absent".
--
-- Elevating the whole worker to studafy_admin would fix that by giving it far more than it needs.
-- This instead is the same move the row-scope helpers themselves make (app.can_read_student,
-- app.teaches_class are all SECURITY DEFINER): one narrow, purpose-built function that crosses the
-- row-scope boundary and nothing else.
--
-- Tenant isolation is NOT crossed. The body filters on current_setting('app.school_id') itself,
-- so a caller can only ever see the school its own transaction is scoped to -- the same boundary
-- the RLS policy would have enforced, restated where the definer's rights would otherwise have
-- lifted it.
CREATE FUNCTION app.student_absence_days(
  target_student_id uuid,
  from_date date,
  to_date date
)
RETURNS TABLE (session_date date, absent boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT s.session_date, bool_or(r.status = 'absent') AS absent
  FROM app.attendance_records AS r
  JOIN app.attendance_sessions AS s
    ON s.id = r.attendance_session_id
   AND s.school_id = r.school_id
   AND s.created_at = r.session_created_at
  WHERE r.school_id = current_setting('app.school_id')::uuid
    AND r.student_id = target_student_id
    -- Semantic filter: which days count.
    AND s.session_date BETWEEN from_date AND to_date
    -- Pruning hints on both partitioned sides. Neither narrows the result -- session_date above
    -- already does -- but dropping either makes the planner read every monthly partition of that
    -- table. The month of slack absorbs the skew between created_at (when it was recorded) and
    -- session_date (the day it describes).
    AND r.created_at >= (from_date - 31)::timestamptz
    AND s.created_at >= (from_date - 31)::timestamptz
    -- A cancelled session was never taken; its rows are not evidence of absence.
    AND s.status <> 'cancelled'
  GROUP BY s.session_date
  ORDER BY s.session_date DESC
$function$;

-- 000002 grants studafy_app no EXECUTE on functions by default, so this is required, not tidiness.
REVOKE ALL ON FUNCTION app.student_absence_days(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_absence_days(uuid, date, date) TO studafy_app;

RESET ROLE;
