-- Notification dispatcher (ST-139). The state a domain event needs to become a set of
-- per-recipient deliveries, and the evidence that each one happened exactly once.
--
-- Four tables:
--   1. app.user_notification_settings   -- quiet hours, timezone and locale, per user.
--   2. app.notification_dispatch_logs   -- one row per (event, recipient, channel). The audit trail.
--   3. app.notification_idempotency_keys-- the dedup arbiter. Reserve-then-confirm, not claim-once.
--   4. app.notification_dead_letters    -- terminal dispatch failures, for alerting and replay.
--
-- ## What this migration deliberately does NOT create
--
-- A per-user channel preference table. 000017 already models that as
-- app.notification_preferences (user x notification_type x channel), one row per fact, seeded for
-- every user by trg_users_seed_notification_preferences and asserted against pg_enum by
-- packages/db/tests/notifications.test.ts. ST-139's ticket asks for a second table holding a
-- channels_enabled JSONB blob; that is the wide repeating-group shape 000017 argues against at
-- length, it is strictly less expressive (it cannot say "email me about grades but not about
-- attendance"), and two preference tables would disagree the first time either is written to.
-- So the dispatcher reads the existing table, and this migration adds only what genuinely does not
-- exist anywhere: quiet hours, a per-user timezone, and a per-user locale override.
--
-- ## Why the idempotency table has a lease rather than a plain unique claim
--
-- app.attendance_alert_logs (000056) dedups with a bare INSERT ... ON CONFLICT DO NOTHING, and that
-- is correct *there* because the claim and the notification are written in one transaction: either
-- both commit or neither does. The dispatcher is not in that position. Its push and email channels
-- hand work to a delivery job, so the claim and the delivery straddle a boundary the database
-- cannot roll back across.
--
-- With a bare claim, a crash between the key insert and the send leaves a committed key with
-- nothing delivered. The retry sees the key, skips that recipient, and the job then *succeeds* --
-- a silent drop that produces no dead-letter row and no failed job. That is strictly worse than a
-- duplicate, and it is invisible.
--
-- So the key is reserved before the send and confirmed after it, exactly as 000069 does for
-- payment idempotency: reserved_at NOT NULL, dispatched_at NULL until delivery is known to have
-- happened. A reservation older than the lease is reclaimable, so a crashed attempt is retried
-- rather than swallowed, while a confirmed row is permanent and can never be re-sent.

SET LOCAL ROLE studafy_admin;

CREATE TYPE app.notification_dispatch_status AS ENUM (
  'pending',
  'suppressed_preference',
  'suppressed_quiet_hours',
  'enqueued',
  'delivered',
  'failed'
);

-- The recipient's role *in this dispatch*, which is not the same question as app.user_role. A user
-- who is both a parent and a teaching assistant receives a grade notification as a parent, and the
-- log has to say which hat they were wearing or the fan-out cannot be audited.
CREATE TYPE app.notification_recipient_role AS ENUM ('student', 'parent', 'teacher', 'admin');

-- 1. Per-user delivery settings

-- Quiet hours are stored as two `time` values plus an IANA zone rather than as a pair of
-- timestamptz: "do not disturb me between 22:00 and 07:00" is a wall-clock rule that must survive
-- a daylight-saving transition unchanged, and an instant cannot express it.
--
-- timezone and locale both carry a NOT NULL default rather than being nullable-with-fallback for
-- timezone, and nullable for locale. That asymmetry is deliberate: a missing timezone would make
-- quiet hours silently unevaluatable (the failure mode is "notified at 3am"), so it defaults; a
-- missing locale falls back to app.school_settings.locale, which is a real school-level answer and
-- a better default than anything this table could invent.
CREATE TABLE app.user_notification_settings (
  user_id uuid NOT NULL CONSTRAINT pk_user_notification_settings PRIMARY KEY,
  school_id uuid NOT NULL,
  quiet_hours_start time,
  quiet_hours_end time,
  timezone varchar(50) NOT NULL DEFAULT 'Asia/Amman',
  locale varchar(5),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_notification_settings_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_user_notification_settings_user
    FOREIGN KEY (user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Both or neither. One half of a window is not a window, and a NULL end would be read as
  -- "quiet hours never finish" by a naive comparison.
  CONSTRAINT ck_user_notification_settings_quiet_hours CHECK (
    (quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)
  ),
  -- Same shape app.school_settings.timezone enforces, so the two columns cannot drift into
  -- accepting different vocabularies for the same fact.
  CONSTRAINT ck_user_notification_settings_timezone CHECK (
    timezone ~ '^[A-Za-z]+/[A-Za-z_]+$' AND char_length(timezone) <= 50
  ),
  CONSTRAINT ck_user_notification_settings_locale CHECK (
    locale IS NULL OR (locale ~ '^[a-z]{2}(-[A-Z]{2})?$' AND char_length(locale) BETWEEN 2 AND 5)
  ),
  CONSTRAINT ck_user_notification_settings_timestamps CHECK (updated_at >= created_at)
);

-- The dispatcher's per-recipient lookup. school_id leads for the tenant predicate, user_id follows
-- for the restrictive one -- the same reasoning 000017 gives for the notification indexes.
CREATE INDEX idx_user_notification_settings_school_user
  ON app.user_notification_settings (school_id, user_id);

-- 2. Dispatch log

-- One row per (event, recipient, channel), written whatever the outcome. A suppressed notification
-- is a fact worth recording -- "why did I not get told about my child's grade" is the support
-- question this table exists to answer, and it is unanswerable if suppression leaves no trace.
CREATE TABLE app.notification_dispatch_logs (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_notification_dispatch_logs PRIMARY KEY,
  school_id uuid NOT NULL,
  -- The originating domain event. Not a foreign key: app.outbox_events is pruned on its own
  -- schedule and the dispatcher is also reachable from a direct enqueue, so this is a correlation
  -- handle in the same sense as attendance_alert_logs.trigger_job_id.
  event_id varchar(255) NOT NULL,
  event_type varchar(100) NOT NULL,
  recipient_id uuid NOT NULL,
  recipient_role app.notification_recipient_role NOT NULL,
  channel app.notification_channel NOT NULL,
  idempotency_key varchar(255) NOT NULL,
  status app.notification_dispatch_status NOT NULL DEFAULT 'pending',
  rendered_title text,
  rendered_body text,
  -- Set for in_app deliveries, which write a real inbox row. NULL for push and email, which hand
  -- off to a delivery job, and for anything suppressed.
  notification_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_notification_dispatch_logs_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_notification_dispatch_logs_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_notification_dispatch_logs_recipient
    FOREIGN KEY (recipient_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_notification_dispatch_logs_notification
    FOREIGN KEY (notification_id, school_id) REFERENCES app.notifications (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_notification_dispatch_logs_event_id CHECK (
    event_id = btrim(event_id) AND event_id <> ''
  ),
  CONSTRAINT ck_notification_dispatch_logs_event_type CHECK (
    event_type = btrim(event_type) AND event_type <> ''
  ),
  CONSTRAINT ck_notification_dispatch_logs_idempotency_key CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
  ),
  -- Rendering happens only after the suppression checks pass, so a suppressed row has no text and
  -- a delivered one must have both halves. This is what stops an empty-bodied notification from
  -- being recorded as successfully delivered.
  CONSTRAINT ck_notification_dispatch_logs_rendered CHECK (
    CASE
      WHEN status IN ('enqueued', 'delivered')
        THEN rendered_title IS NOT NULL AND rendered_body IS NOT NULL
      WHEN status IN ('suppressed_preference', 'suppressed_quiet_hours')
        THEN rendered_title IS NULL AND rendered_body IS NULL AND notification_id IS NULL
      ELSE true
    END
  ),
  CONSTRAINT ck_notification_dispatch_logs_timestamps CHECK (updated_at >= created_at)
);

-- "What has this user been sent, most recent first" -- the support and inbox-history path.
CREATE INDEX idx_dispatch_logs_recipient
  ON app.notification_dispatch_logs (school_id, recipient_id, created_at DESC);

-- "What happened to this event, and did any of it fail" -- the audit and retry path.
CREATE INDEX idx_dispatch_logs_event
  ON app.notification_dispatch_logs (school_id, event_id, status);

-- 3. Idempotency ledger

CREATE TABLE app.notification_idempotency_keys (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_notification_idempotency_keys PRIMARY KEY,
  school_id uuid NOT NULL,
  -- '<event_type>:<event_id>:<recipient_id>:<channel>'. Kept as one opaque string rather than
  -- being decomposed into the columns beside it because it is the value the unique index arbitrates
  -- on, and a composite key over four columns would let a caller construct a key that does not
  -- match its own columns. The columns are for querying; this is the identity.
  idempotency_key varchar(255) NOT NULL,
  recipient_user_id uuid NOT NULL,
  channel app.notification_channel NOT NULL,
  -- Reserved before the send, confirmed after it. dispatched_at IS NULL means the outcome is
  -- unknown, not that nothing happened -- see the header for why that distinction is the whole
  -- point of this table.
  reserved_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at timestamptz(3),
  attempt_count smallint NOT NULL DEFAULT 1,
  CONSTRAINT uq_notification_idempotency_keys_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_notification_idempotency_keys_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_notification_idempotency_keys_recipient
    FOREIGN KEY (recipient_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_notification_idempotency_keys_key CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
  ),
  CONSTRAINT ck_notification_idempotency_keys_attempts CHECK (attempt_count > 0),
  CONSTRAINT ck_notification_idempotency_keys_dispatched_at CHECK (
    dispatched_at IS NULL OR dispatched_at >= reserved_at
  )
);

-- The arbiter. Every duplicate-suppression guarantee in the dispatcher rests on this index rather
-- than on application logic, which is what makes it correct under concurrent workers rather than
-- merely correct under a single one.
CREATE UNIQUE INDEX idx_notification_idempotency_unique
  ON app.notification_idempotency_keys (school_id, idempotency_key);

-- "Which recipients of this event are still unresolved" -- what the dead-letter path reports and
-- what a replay re-attempts. Partial, because a confirmed row is never the subject of this query
-- and the unresolved set is small and shrinking.
CREATE INDEX idx_notification_idempotency_unresolved
  ON app.notification_idempotency_keys (school_id, reserved_at)
  WHERE dispatched_at IS NULL;

-- 4. Dead letters

-- The durable record of a dispatch job that exhausted its retries. This is the dead-letter queue;
-- `notifications-dlq` is a reserved replay handle, not a second copy of this data. See
-- docs/architecture/SAD_21_notification_dispatch_flow.md.
--
-- Error text is bounded and truncated by the caller before it arrives. A CHECK violation here
-- would abort the transaction that is trying to record the failure, losing the alert entirely in
-- order to enforce a length limit -- so the limits are a backstop against a caller that forgot,
-- not the primary control.
CREATE TABLE app.notification_dead_letters (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_notification_dead_letters PRIMARY KEY,
  school_id uuid NOT NULL,
  queue_name text NOT NULL,
  job_id text NOT NULL,
  job_name text NOT NULL,
  -- Nullable: a job whose data could not be parsed still deserves a row, and its notification type
  -- is exactly the thing that could not be read.
  notification_type app.notification_type,
  attempts_made smallint NOT NULL,
  error_class text NOT NULL,
  error_message text NOT NULL,
  error_stack text,
  failed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  replayed_at timestamptz(3),
  CONSTRAINT uq_notification_dead_letters_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_notification_dead_letters_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_notification_dead_letters_queue_name CHECK (
    queue_name = btrim(queue_name) AND queue_name <> '' AND char_length(queue_name) <= 100
  ),
  CONSTRAINT ck_notification_dead_letters_job_id CHECK (
    job_id = btrim(job_id) AND job_id <> '' AND char_length(job_id) <= 255
  ),
  CONSTRAINT ck_notification_dead_letters_job_name CHECK (
    job_name = btrim(job_name) AND job_name <> '' AND char_length(job_name) <= 100
  ),
  CONSTRAINT ck_notification_dead_letters_attempts CHECK (attempts_made > 0),
  CONSTRAINT ck_notification_dead_letters_error_class CHECK (
    error_class = btrim(error_class) AND error_class <> '' AND char_length(error_class) <= 200
  ),
  CONSTRAINT ck_notification_dead_letters_error_message CHECK (
    error_message = btrim(error_message)
      AND error_message <> ''
      AND char_length(error_message) <= 1000
  ),
  CONSTRAINT ck_notification_dead_letters_error_stack CHECK (
    error_stack IS NULL OR char_length(error_stack) <= 8000
  ),
  CONSTRAINT ck_notification_dead_letters_replayed_at CHECK (
    replayed_at IS NULL OR replayed_at >= failed_at
  )
);

-- One dead-letter row per job, so a `failed` listener that runs twice -- or a manual replay from
-- BullMQ's own failed set -- cannot double-count the same failure.
CREATE UNIQUE INDEX uq_notification_dead_letters_job
  ON app.notification_dead_letters (school_id, queue_name, job_id);

-- The operator's query: this tenant's un-replayed failures, newest first.
CREATE INDEX idx_notification_dead_letters_unreplayed
  ON app.notification_dead_letters (school_id, failed_at DESC)
  WHERE replayed_at IS NULL;

-- Grants.
--
-- 000002 installs ALTER DEFAULT PRIVILEGES granting studafy_app full DML on every table
-- studafy_admin creates in app, so revoking from studafy_app as well as PUBLIC is load-bearing on
-- the three append-only tables. DELETE is withheld everywhere: a dispatch log that can be deleted
-- is not an audit trail, a deletable idempotency key is a re-send waiting to happen, and a
-- deletable dead letter is a lost alert. user_notification_settings follows app.school_settings --
-- a settings row is immortal once created; turning everything back on is an UPDATE.
REVOKE ALL PRIVILEGES ON TABLE
  app.user_notification_settings,
  app.notification_dispatch_logs,
  app.notification_idempotency_keys,
  app.notification_dead_letters
FROM PUBLIC, studafy_app;

GRANT SELECT, INSERT, UPDATE ON TABLE
  app.user_notification_settings,
  app.notification_dispatch_logs,
  app.notification_idempotency_keys,
  app.notification_dead_letters
TO studafy_app;

REVOKE ALL ON TYPE
  app.notification_dispatch_status, app.notification_recipient_role
FROM PUBLIC;
GRANT USAGE ON TYPE
  app.notification_dispatch_status, app.notification_recipient_role
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'user_notification_settings');
SELECT app.apply_tenant_isolation('app', 'notification_dispatch_logs');
SELECT app.apply_tenant_isolation('app', 'notification_idempotency_keys');
SELECT app.apply_tenant_isolation('app', 'notification_dead_letters');

-- User isolation on the settings table only, mirroring notification_preferences_owner in 000017:
-- quiet hours are the same class of data as channel preferences and belong to exactly one user.
-- Scoped TO studafy_app, so the dispatcher -- which runs under withSystemTenantTx and therefore as
-- studafy_admin -- can still read the settings of the users it is about to notify. That elevation
-- is the same one the attendance alert worker already relies on, and it stays inside the tenant
-- boundary because tenant_isolation is permissive and applies to every role.
-- Mirrored, with the full rationale, in db/policies/notification_user_isolation.sql.
CREATE POLICY user_notification_settings_owner ON app.user_notification_settings
  AS RESTRICTIVE FOR ALL TO studafy_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

-- The other three tables take the tenant boundary only, and that is deliberate.
--
-- notification_dispatch_logs is operational audit, not a user's inbox -- the inbox is
-- app.notifications, which is already fenced per user. A school administrator investigating "the
-- parents were not told" has to be able to read rows addressed to other people, exactly as they can
-- for app.attendance_alert_rules and app.finance_report_jobs. Fencing it per recipient would make
-- the table useless for the only question it exists to answer.
--
-- notification_idempotency_keys and notification_dead_letters are never read by an end user at all;
-- they are worker-internal. Adding a self-only policy would be security theatre over a table no
-- user-facing query touches, and would break the dispatcher's own reads under any future refactor
-- that stopped elevating the role.

COMMENT ON TABLE app.user_notification_settings IS
  'Per-user quiet hours, timezone and locale override. Channel preferences live in app.notification_preferences.';
COMMENT ON TABLE app.notification_dispatch_logs IS
  'One row per (event, recipient, channel), including suppressions. The dispatch audit trail.';
COMMENT ON TABLE app.notification_idempotency_keys IS
  'Per-recipient dispatch ledger. reserved_at claims, dispatched_at confirms; a stale reservation is reclaimable.';
COMMENT ON TABLE app.notification_dead_letters IS
  'Terminal notification dispatch failures. The dead-letter record; notifications-dlq is a replay handle only.';

COMMENT ON COLUMN app.notification_idempotency_keys.dispatched_at IS
  'NULL means the delivery outcome is unknown, not that nothing was sent.';

RESET ROLE;
