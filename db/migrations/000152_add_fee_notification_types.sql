-- studafy:migration transaction=off
--
-- Fee notifications to guardians: an invoice was issued, a payment was received, a reminder about
-- an overdue balance, and a family statement sent by finance.
--
-- Mirrors NOTIFICATION_TYPES in packages/constants/src/notifications.ts label-for-label, same as
-- every other value in this enum (000017, 000057, 000082, 000104, 000126). All four are optional:
-- they are left out of ck_notification_preferences_mandatory_enabled and
-- ck_notification_preferences_digest_eligible (000083), so a guardian can turn each off and none is
-- batched into a digest. Written by apps/api/src/modules/finance/communications; 000153 creates the
-- log that keeps each one to a single send.
--
-- transaction=off is required, not stylistic: PostgreSQL forbids USING a new enum value in the same
-- transaction that added it, and the migration runner wraps every transactional migration in
-- BEGIN/COMMIT. IF NOT EXISTS keeps a re-run a no-op rather than a duplicate_object error, which the
-- runner requires of every non-transactional migration.

SET ROLE studafy_admin;

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'FEE_INVOICE_ISSUED';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'FEE_PAYMENT_RECEIVED';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'FEE_PAYMENT_REMINDER';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'FEE_STATEMENT';

RESET ROLE;
