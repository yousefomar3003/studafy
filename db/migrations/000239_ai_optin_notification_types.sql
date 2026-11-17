-- studafy:migration transaction=off
--
-- Student AI opt-in notifications (phase 2 of the Student AI programme; 000235). In-app and push
-- only, never emailed:
--
--   * AI_OPTIN_AVAILABLE -- to a parent, once per child and window: "Student AI is available for
--                           <child>" (the workers' hourly run-ai-optin-notices job).
--   * AI_OPTIN_CONFIRMED -- to a child's parents, when the opt-in is recorded (by a parent in the
--                           app or by the school on their behalf), written by the API in the same
--                           transaction.
--   * AI_OPTIN_SUMMARY   -- to the school's ORG_ADMINs and PRINCIPALs, once a day when there are new
--                           opt-ins: how many, the total, and how many wait for a seat.
--
-- Mirrors NOTIFICATION_TYPES in packages/constants/src/notifications.ts. Optional and immediate-only
-- like MARKS_RELEASED (000230): left out of ck_notification_preferences_mandatory_enabled and
-- ck_notification_preferences_digest_eligible (000083); push preferences and quiet hours apply.
--
-- transaction=off: PostgreSQL forbids using a new enum value in the transaction that added it
-- (nothing below uses it). Every statement is re-runnable.

SET ROLE studafy_admin;
SET lock_timeout = '5s';

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'AI_OPTIN_AVAILABLE';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'AI_OPTIN_CONFIRMED';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'AI_OPTIN_SUMMARY';

RESET lock_timeout;
RESET ROLE;
