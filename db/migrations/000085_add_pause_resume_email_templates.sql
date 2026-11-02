-- Add email templates for AI subscription pause/resume notifications (school suspension).
--
-- Also adds 'seat-drift': app.email_template (000077) was created with only
-- ('invitation', 'verification', 'dunning', 'digest', 'alert'), but ST-136's seat-reconciliation
-- sweep already writes template = 'seat-drift' via app.email_deliveries.template (see
-- apps/workers/src/queues/notifications/email/dispatcher.ts's recordDelivery). That value has never
-- been a legal member of this enum, so the first seat-drift email send would fail at INSERT time
-- with "invalid input value for enum app.email_template". Fixed here since this migration already
-- touches the same enum.
ALTER TYPE app.email_template ADD VALUE IF NOT EXISTS 'seat-drift';
ALTER TYPE app.email_template ADD VALUE IF NOT EXISTS 'ai-subscription-paused';
ALTER TYPE app.email_template ADD VALUE IF NOT EXISTS 'ai-subscription-resumed';
