-- studafy:migration transaction=off
--
-- In-app reminders for school license billing (docs/billing/feature-licensing.md, session 3), sent by
-- the workers' license reminder job to the super admins and to the school's admins and principals:
--
--   * LICENSE_EXPIRING          -- a license ends in 30 days, and again in 7.
--   * LICENSE_INVOICE_DUE       -- an invoice falls due today with a balance.
--   * LICENSE_INVOICE_OVERDUE   -- an invoice has passed its due date with a balance.
--   * LICENSE_RECEIPT_UPLOADED  -- a school uploaded a transfer receipt (super admins only).
--
-- Mirrors NOTIFICATION_TYPES in packages/constants/src/notifications.ts. Optional: left out of
-- ck_notification_preferences_mandatory_enabled and ck_notification_preferences_digest_eligible
-- (000083).
--
-- transaction=off for the same reason as 000152 and 000164: PostgreSQL forbids using a new enum value
-- in the transaction that added it. IF NOT EXISTS keeps a re-run a no-op.

SET ROLE studafy_admin;

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'LICENSE_EXPIRING';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'LICENSE_INVOICE_DUE';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'LICENSE_INVOICE_OVERDUE';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'LICENSE_RECEIPT_UPLOADED';

RESET ROLE;
