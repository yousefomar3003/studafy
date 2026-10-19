-- studafy:migration transaction=off
--
-- Add DIRECT_MESSAGE to app.notification_type.
--
-- Raised by apps/api/src/modules/messaging when a parent or teacher sends a message in a
-- parent<->teacher conversation (000127 creates the tables): the other participant gets one
-- app.notifications row carrying metadata {"conversation_id"}. Mirrors NOTIFICATION_TYPES in
-- packages/constants/src/notifications.ts label-for-label, same as every other value in this enum
-- (000017, 000057, 000082, 000088, 000090, 000096, 000104). Deliberately absent from both
-- ck_notification_preferences_mandatory_enabled and ck_notification_preferences_digest_eligible
-- (000083): a recipient may disable it, and a reply that waits for the next digest window loses the
-- point of being a conversation, so it stays immediate-only.
--
-- transaction=off is required, not stylistic: PostgreSQL forbids USING a new enum value in the same
-- transaction that added it, and the migration runner wraps every transactional migration in
-- BEGIN/COMMIT. IF NOT EXISTS keeps a re-run a no-op rather than a duplicate_object error, which the
-- runner requires of every non-transactional migration.

SET ROLE studafy_admin;

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'DIRECT_MESSAGE';

RESET ROLE;
