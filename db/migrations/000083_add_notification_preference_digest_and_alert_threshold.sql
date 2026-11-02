-- Notification preferences API (ST-143): digest mode, the mandatory-type lock, and a parent's
-- personal attendance-alert threshold.
--
-- Two tables change, for two different reasons.
--
-- app.notification_preferences gains `digest`, plus two CHECK constraints that make the API's own
-- validation rules true at the database's arbiter of record rather than true only as long as every
-- caller goes through the API:
--
--   ck_notification_preferences_digest_channel  -- digest only makes sense for a channel with a
--   batchable delivery, which today is only email (see email/digest-producer.ts). in_app is read
--   live in the inbox and push is meant to interrupt; neither has a digest concept to opt into.
--
--   ck_notification_preferences_digest_eligible  -- mirrors DIGEST_ELIGIBLE_NOTIFICATION_TYPES in
--   packages/constants/src/notifications.ts. Deadline- and status-critical types stay
--   immediate-only; see that constant's comment for the per-type reasoning. The two lists are
--   independent statements of the same fact and must be kept in lockstep by hand, the same way
--   app.notification_type already mirrors NOTIFICATION_TYPES.
--
--   ck_notification_preferences_mandatory_enabled  -- mirrors MANDATORY_NOTIFICATION_TYPES. A
--   mandatory type can never be written with enabled = false, by anyone, through any path -- not
--   only through the notification preferences API. app.seed_default_notification_preferences
--   (000017) always inserts enabled = true, so the seeding trigger already satisfies this without
--   change; the constraint is what stops a later mutation from disabling it.
--
-- app.user_notification_settings gains `attendance_alert_threshold`: a parent's personal absence
-- threshold, independent of app.attendance_alert_rules (000056), which is the school's own
-- administrator-configured threshold. The two are deliberately separate facts rather than one
-- overloaded column -- a school sets the floor every parent's alerts are evaluated against, and this
-- lets one parent additionally ask to be told sooner than that floor without the school's own rule
-- (and the alert log's dedup key, which embeds threshold_value) changing meaning for every other
-- parent. NULL means "no personal override", the same absent-row-means-default shape 000017 gives
-- notification_preferences and 000074 gives quiet hours -- a parent who has never opened this
-- setting is not silently opted into anything.
--
-- Consuming attendance_alert_threshold in app.student_absence_days / the attendance alert worker
-- (apps/workers/src/queues/notifications/attendance-alert.worker.ts) is not part of this migration
-- or this ticket: that worker evaluates one school-wide rule per breach and re-arms per
-- (student, parent, threshold) via uq_attendance_alert_logs_dedup, and folding a second,
-- per-parent threshold into that evaluation is a change to the alert engine, not to preferences
-- storage. This column makes the setting real and persisted; wiring it into evaluation is a
-- follow-up, stated plainly rather than silently half-built.

SET LOCAL ROLE studafy_admin;

ALTER TABLE app.notification_preferences
  ADD COLUMN digest boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT ck_notification_preferences_digest_channel
    CHECK (NOT digest OR channel = 'email'),
  ADD CONSTRAINT ck_notification_preferences_digest_eligible
    CHECK (
      NOT digest OR notification_type IN (
        'DISCUSSION_REPLY', 'STUDY_GROUP_INVITE', 'COURSE_PUBLISHED', 'ATTENDANCE_ALERT'
      )
    ),
  ADD CONSTRAINT ck_notification_preferences_mandatory_enabled
    CHECK (notification_type NOT IN ('ADMIN_ANNOUNCEMENT') OR enabled);

ALTER TABLE app.user_notification_settings
  ADD COLUMN attendance_alert_threshold smallint,
  ADD CONSTRAINT ck_user_notification_settings_attendance_alert_threshold
    CHECK (attendance_alert_threshold IS NULL OR attendance_alert_threshold BETWEEN 1 AND 365);

RESET ROLE;
