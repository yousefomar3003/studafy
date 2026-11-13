-- studafy:migration transaction=off
--
-- In-app + push notices for the everyday school events nobody was told about before:
--
--   * ASSIGNMENT_PUBLISHED -- a teacher published an assignment: the class's students and their parents.
--   * ASSIGNMENT_GRADED    -- a teacher released a mark on a hand-in: that student and their parents.
--   * ATTENDANCE_MARKED    -- a submitted register marked a student absent or late: their parents.
--
-- Written by the workers' outbox notify consumer (apps/workers/src/queues/notifications/school-events)
-- from assignment.published, submission.graded and attendance.sessionSubmitted. Mirrors
-- NOTIFICATION_TYPES in packages/constants/src/notifications.ts. Optional: left out of
-- ck_notification_preferences_mandatory_enabled and ck_notification_preferences_digest_eligible (000083).
--
-- transaction=off for the same reason as 000152, 000164 and 000166: PostgreSQL forbids using a new
-- enum value in the transaction that added it. IF NOT EXISTS keeps a re-run a no-op.

SET ROLE studafy_admin;

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'ASSIGNMENT_PUBLISHED';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'ASSIGNMENT_GRADED';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'ATTENDANCE_MARKED';

RESET ROLE;
