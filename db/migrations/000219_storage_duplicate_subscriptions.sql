-- Duplicate storage subscriptions: a school must never pay for two storage add-ons at once.
--
-- One storage add-on per school (000205). If a second Stripe subscription for storage ever reaches
-- Studafy while the school's add-on is live under another one -- a second checkout paid before the
-- first one's webhook arrived, for example -- the newest purchase is the one the school keeps: the
-- add-on row moves to it (packages/billing attribution), and the subscription it replaced is
-- recorded here. A billing worker (apps/workers storage-duplicate-resolver.ts) then ends that old
-- subscription at once in Stripe and refunds the unused part of its period.
--
-- Each row is also the record the super admin sees on the platform's system-health page, from the
-- moment it is found until it is settled, with its refund and any error.
--
--   pending      found; the worker will cancel and refund it (next_attempt_at says when)
--   resolved     canceled in Stripe, and refunded where anything was left to refund
--   needs_review a person must look: the worker gave up after its attempts, or (source 'event') a
--                second live storage subscription was seen with no completed checkout naming it.
--                Studafy never cancels that one on its own: a subscription's own events can arrive
--                before its checkout completes, and it may be the purchase the school meant to keep.
--                If its checkout completion does arrive, the row is dropped and the usual newest-wins
--                move runs.

SET ROLE studafy_admin;

CREATE TABLE app.storage_duplicate_subscriptions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_storage_duplicate_subscriptions PRIMARY KEY,
  school_id uuid NOT NULL,
  -- The school's add-on row the duplicate belonged to.
  storage_subscription_id uuid NOT NULL,
  -- The subscription the school no longer keeps: canceled and refunded by the worker.
  stripe_subscription_id text NOT NULL,
  -- The subscription the school keeps (the add-on row's own, after the move).
  kept_stripe_subscription_id text,
  -- How it was found: a second completed checkout ('checkout'), or another event ('event').
  source text NOT NULL DEFAULT 'checkout',
  -- The billing event that found it (app.billing_events.provider_event_id).
  detected_by_event_id text,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error text,
  canceled_at timestamptz,
  -- Fixed before the refund is requested, so a retry asks Stripe for exactly the same refund.
  refund_amount_minor bigint,
  refund_currency text,
  stripe_refund_id text,
  -- What the old subscription took and could not be returned in full (for a person to review).
  unrefunded_minor bigint,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_storage_duplicate_subscriptions_stripe_subscription_id
    UNIQUE (stripe_subscription_id),
  CONSTRAINT fk_storage_duplicate_subscriptions_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_storage_duplicate_subscriptions_storage
    FOREIGN KEY (storage_subscription_id, school_id)
    REFERENCES app.storage_subscriptions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_storage_duplicate_subscriptions_status
    CHECK (status IN ('pending', 'resolved', 'needs_review')),
  CONSTRAINT ck_storage_duplicate_subscriptions_source CHECK (source IN ('checkout', 'event')),
  CONSTRAINT ck_storage_duplicate_subscriptions_attempts CHECK (attempts >= 0),
  CONSTRAINT ck_storage_duplicate_subscriptions_refund CHECK (
    refund_amount_minor IS NULL OR refund_amount_minor >= 0
  ),
  CONSTRAINT ck_storage_duplicate_subscriptions_resolved CHECK (
    (status = 'resolved') = (resolved_at IS NOT NULL)
  ),
  CONSTRAINT ck_storage_duplicate_subscriptions_not_kept CHECK (
    kept_stripe_subscription_id IS NULL OR kept_stripe_subscription_id <> stripe_subscription_id
  ),
  CONSTRAINT ck_storage_duplicate_subscriptions_timestamps CHECK (updated_at >= created_at)
);

-- The worker's claim: what is still pending and due.
CREATE INDEX idx_storage_duplicate_subscriptions_due
  ON app.storage_duplicate_subscriptions (school_id, next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX idx_storage_duplicate_subscriptions_storage
  ON app.storage_duplicate_subscriptions (storage_subscription_id);

COMMENT ON TABLE app.storage_duplicate_subscriptions IS
  'A second Stripe storage subscription a school was charged for (000219): the one replaced by the newest purchase, to be canceled and refunded by the billing worker, and shown to the super admin until settled.';

REVOKE ALL PRIVILEGES ON TABLE app.storage_duplicate_subscriptions FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.storage_duplicate_subscriptions TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'storage_duplicate_subscriptions');

RESET ROLE;
