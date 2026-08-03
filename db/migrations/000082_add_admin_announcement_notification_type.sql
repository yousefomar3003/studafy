-- studafy:migration transaction=off
--
-- Add ADMIN_ANNOUNCEMENT to app.notification_type (ST-143).
--
-- Mirrors NOTIFICATION_TYPES in packages/constants/src/notifications.ts label-for-label, same as
-- every other value in this enum (000017, 000057). This is the first notification type the platform
-- marks mandatory (MANDATORY_NOTIFICATION_TYPES in that file) -- 000083 adds the preference-table
-- constraint that makes "cannot be disabled" a database-level guarantee rather than an API-only one.
--
-- No sender exists yet, following the same order 000057 set: that migration added ATTENDANCE_ALERT
-- ahead of the worker that would eventually write it. An announcements-sending feature is a separate
-- ticket; this only adds the vocabulary the preferences API needs to have a real mandatory type to
-- lock, rather than an empty set no test could exercise.
--
-- transaction=off is required, not stylistic: PostgreSQL forbids USING a new enum value in the same
-- transaction that added it, and the migration runner wraps every transactional migration in
-- BEGIN/COMMIT. IF NOT EXISTS keeps a re-run a no-op rather than a duplicate_object error, which the
-- runner requires of every non-transactional migration.

SET ROLE studafy_admin;

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'ADMIN_ANNOUNCEMENT';

RESET ROLE;
