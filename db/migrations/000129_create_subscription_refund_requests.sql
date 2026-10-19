-- Subscription refund requests: a school administrator asks Studafy to refund a payment for the
-- school's plan, or a student (or their parent) asks for one on the student's AI add-on. Studafy
-- staff review the queue from the platform console and, on approval, the refund is issued through
-- the payment provider that took the payment.
--
-- Depends on 000016 (app.subscriptions, app.ai_subscriptions), 000078
-- (app.billing_subscription_type), 000007 (app.users), and 000006 (app.apply_tenant_isolation).
--
-- Tenant-isolated like every other subscription table: a request belongs to the school whose
-- subscription it concerns. `subscription_id` points at app.subscriptions or app.ai_subscriptions
-- depending on `subscription_type`, so it carries no FK -- the same polymorphic shape
-- app.tap_renewal_attempts (000113) uses.
--
-- `payment_reference` is the payment as the provider names it (a Stripe invoice id, or a Tap charge
-- id -- Tap issues no invoice object), exactly as `GET /api/subscriptions/current/invoices` lists
-- it. A school administrator usually names it when filing; a student or parent cannot see the
-- school's invoices, so their request may arrive without one and the reviewer picks it at approval.
-- `amount_minor`/`currency_code` are that payment's paid amount, recorded when the reference is.
-- `refunded_amount_minor` is what was actually sent to the provider -- a partial refund is less.
--
-- `reviewed_by` has no FK: the reviewer is a platform operator, a user of their own home school,
-- not of the school the request belongs to, so the (user, school) composite FK every other actor
-- column uses cannot hold. The operator's identity is also recorded, with that FK intact, by the
-- audit row written in the operator's home school.
--
-- Workflow: pending -> approved -> {refunded | failed}, or pending -> rejected. `approved` is the
-- in-flight claim taken before the provider is called, so two concurrent approvals cannot both
-- refund; a `failed` refund may be approved again. At most one request per subscription is open
-- (pending or approved) at a time.

SET ROLE studafy_admin;

CREATE TABLE app.subscription_refund_requests (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_subscription_refund_requests PRIMARY KEY,
  school_id uuid NOT NULL,
  subscription_type app.billing_subscription_type NOT NULL,
  subscription_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  provider text NOT NULL,
  payment_reference text,
  amount_minor bigint,
  currency_code text,
  reason text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  refunded_amount_minor bigint,
  provider_refund_id text,
  failure_message text,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_subscription_refund_requests_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_subscription_refund_requests_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subscription_refund_requests_requested_by FOREIGN KEY (requested_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_subscription_refund_requests_provider CHECK (provider IN ('stripe', 'tap')),
  CONSTRAINT ck_subscription_refund_requests_payment_reference CHECK (
    payment_reference IS NULL
    OR (payment_reference = btrim(payment_reference) AND payment_reference <> ''
      AND char_length(payment_reference) <= 255)
  ),
  -- A recorded payment always carries its amount and currency, and neither appears without it.
  CONSTRAINT ck_subscription_refund_requests_payment CHECK (
    (payment_reference IS NULL AND amount_minor IS NULL AND currency_code IS NULL)
    OR (payment_reference IS NOT NULL AND amount_minor > 0 AND currency_code ~ '^[A-Z]{3}$')
  ),
  CONSTRAINT ck_subscription_refund_requests_reason CHECK (reason IN (
    'accidental_purchase', 'duplicate_charge', 'service_issue', 'not_as_described',
    'no_longer_needed', 'other'
  )),
  CONSTRAINT ck_subscription_refund_requests_details CHECK (
    details IS NULL OR (btrim(details) <> '' AND char_length(details) <= 2000)
  ),
  CONSTRAINT ck_subscription_refund_requests_status CHECK (
    status IN ('pending', 'approved', 'rejected', 'refunded', 'failed')
  ),
  CONSTRAINT ck_subscription_refund_requests_review_note CHECK (
    review_note IS NULL OR (btrim(review_note) <> '' AND char_length(review_note) <= 2000)
  ),
  -- A request a reviewer has acted on says who and when; an untouched one says neither.
  CONSTRAINT ck_subscription_refund_requests_review CHECK (
    (status = 'pending') = (reviewed_by IS NULL AND reviewed_at IS NULL)
  ),
  -- A rejection always says why.
  CONSTRAINT ck_subscription_refund_requests_rejection CHECK (
    status <> 'rejected' OR review_note IS NOT NULL
  ),
  -- Anything sent to the provider names the payment and an amount no larger than it.
  CONSTRAINT ck_subscription_refund_requests_refund_amount CHECK (
    refunded_amount_minor IS NULL
    OR (payment_reference IS NOT NULL AND refunded_amount_minor > 0
      AND refunded_amount_minor <= amount_minor)
  ),
  CONSTRAINT ck_subscription_refund_requests_refunded CHECK (
    (status = 'refunded') = (provider_refund_id IS NOT NULL AND refunded_at IS NOT NULL)
  ),
  CONSTRAINT ck_subscription_refund_requests_sent CHECK (
    status NOT IN ('approved', 'refunded', 'failed') OR refunded_amount_minor IS NOT NULL
  ),
  CONSTRAINT ck_subscription_refund_requests_failure_message CHECK (
    failure_message IS NULL OR char_length(failure_message) <= 2000
  ),
  CONSTRAINT ck_subscription_refund_requests_timestamps CHECK (updated_at >= created_at)
);

-- One open request per subscription: a second submit is a 409, not a second queue row.
CREATE UNIQUE INDEX uq_subscription_refund_requests_open
  ON app.subscription_refund_requests (school_id, subscription_type, subscription_id)
  WHERE status IN ('pending', 'approved');

-- The requester's own list and the console's per-school read, newest first.
CREATE INDEX idx_subscription_refund_requests_school_created
  ON app.subscription_refund_requests (school_id, created_at DESC, id);
CREATE INDEX idx_subscription_refund_requests_requested_by
  ON app.subscription_refund_requests (requested_by, school_id);

REVOKE ALL PRIVILEGES ON TABLE app.subscription_refund_requests FROM PUBLIC;
-- No DELETE: a refund request is part of the school's billing record.
GRANT SELECT, INSERT, UPDATE ON TABLE app.subscription_refund_requests TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'subscription_refund_requests');

COMMENT ON TABLE app.subscription_refund_requests IS
  'Refund requests for a school plan or a student AI add-on, reviewed by Studafy staff and issued through the payment provider that took the payment.';

RESET ROLE;
