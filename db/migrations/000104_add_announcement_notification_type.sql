-- studafy:migration transaction=off
--
-- Add ANNOUNCEMENT to app.notification_type (ST-194).
--
-- Mirrors NOTIFICATION_TYPES in packages/constants/src/notifications.ts label-for-label, same as
-- every other value in this enum (000017, 000057, 000082). This is ADMIN_ANNOUNCEMENT's
-- non-mandatory sibling: ADMIN_ANNOUNCEMENT is the platform's only MANDATORY_NOTIFICATION_TYPES
-- entry (000083's ck_notification_preferences_mandatory_enabled names it and only it), so routing
-- every announcement through it would make the compose UI's "mandatory" toggle a no-op — there
-- would be no less-strict type for "mandatory = false" to mean anything. This value is deliberately
-- left out of both ck_notification_preferences_mandatory_enabled and
-- ck_notification_preferences_digest_eligible (000083), so a recipient can disable it like any
-- ordinary notification type while it still stays immediate-only (see DIGEST_ELIGIBLE_NOTIFICATION_TYPES'
-- comment for why).
--
-- Sent by apps/api/src/modules/announcements and apps/workers' scheduled-publish sweep (000105
-- creates the tables both read and write).
--
-- transaction=off is required, not stylistic: PostgreSQL forbids USING a new enum value in the same
-- transaction that added it, and the migration runner wraps every transactional migration in
-- BEGIN/COMMIT. IF NOT EXISTS keeps a re-run a no-op rather than a duplicate_object error, which the
-- runner requires of every non-transactional migration.

SET ROLE studafy_admin;

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT';

RESET ROLE;
