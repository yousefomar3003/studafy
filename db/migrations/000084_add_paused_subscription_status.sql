-- Add the `paused` subscription status: AI subscriptions pausing on school suspension.
--
-- `closed` (000042) is terminal by design and has no outgoing edges (SAD §11), so a suspension
-- that must resume cannot reuse it. `paused` is the new, genuinely resumable state: an AI
-- subscription enters it when the student's school is suspended and leaves it back to `active`
-- when the school is reactivated. See packages/billing/src/state-machine.ts's AI_TRANSITIONS for
-- the legal edges -- school subscriptions never enter this value.
ALTER TYPE app.subscription_status ADD VALUE IF NOT EXISTS 'paused';
