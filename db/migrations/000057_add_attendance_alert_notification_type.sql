-- studafy:migration transaction=off
--
-- Add ATTENDANCE_ALERT to app.notification_type (ST-110).
--
-- 000017 states that this enum mirrors NOTIFICATION_TYPES in packages/constants label-for-label,
-- so this lands in lockstep with the constant. It is the first notification type the platform
-- actually writes at runtime: app.notifications has existed since 000017 with no production
-- writer, and the attendance alert worker is the first.
--
-- transaction=off is required, not stylistic. PostgreSQL forbids USING a new enum value in the
-- same transaction that added it, and the migration runner wraps every transactional migration in
-- BEGIN/COMMIT -- so an in-transaction ADD VALUE would leave the value unusable to anything else
-- running in that transaction and is refused outright on older versions. The runner requires
-- non-transactional migrations be idempotent, which IF NOT EXISTS satisfies: re-running this is a
-- no-op rather than a duplicate_object error.

SET ROLE studafy_admin;

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'ATTENDANCE_ALERT';

RESET ROLE;
