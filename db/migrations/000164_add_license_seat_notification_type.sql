-- studafy:migration transaction=off
--
-- In-app notice to a person who pays for a feature through the App Store and has just received a
-- school seat that covers it: Apple renewals cannot be stopped from our server, so it tells them how
-- to turn renewal off themselves (docs/billing/feature-licensing.md, session 2).
--
-- Mirrors NOTIFICATION_TYPES.LICENSE_SEAT_APPLE_RENEWAL in packages/constants/src/notifications.ts.
-- Optional: left out of ck_notification_preferences_mandatory_enabled and
-- ck_notification_preferences_digest_eligible (000083). Written by apps/api/src/modules/licensing.
--
-- transaction=off for the same reason as 000152: PostgreSQL forbids using a new enum value in the
-- transaction that added it. IF NOT EXISTS keeps a re-run a no-op.

SET ROLE studafy_admin;

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'LICENSE_SEAT_APPLE_RENEWAL';

RESET ROLE;
