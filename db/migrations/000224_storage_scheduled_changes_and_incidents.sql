-- Storage billing behaves like an app-store subscription (ADR docs/adr/0022-storage-billing-store-model.md).
--
-- 1. A scheduled change. A move to more storage on the same billing interval applies at once with
--    one prorated charge. A move to less storage, or to the other interval, applies at the next
--    renewal: nothing is charged or credited now, the school keeps what it pays for until then, and
--    the new tier is billed from the renewal on. Stripe holds the change as a subscription schedule
--    (stripe_schedule_id); the add-on row records what it will become (pending_*), and the webhook
--    pipeline applies it when the subscription moves to the new price. Undoing it releases the
--    schedule and clears these columns.
--
-- 2. Billing incidents. After an immediate change is charged, the API compares what Stripe took with
--    the amount the school confirmed. Anything more is refunded at once; each such case is kept here
--    and shown to the super admin on the platform's system-health page.
--
--   refunded      the excess was refunded automatically
--   needs_review  the refund could not be made: a person must finish it in Stripe

SET ROLE studafy_admin;

-- The foreign key's validation scan runs under the table's forced row-level security, which needs a
-- tenant set (see 000114, 000198). The new column is NULL on every existing row, so the nil tenant's
-- empty scan is exact.
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

ALTER TABLE app.storage_subscriptions
  ADD COLUMN pending_plan_price_id uuid,
  ADD COLUMN pending_cap_bytes bigint,
  ADD COLUMN pending_effective_at timestamptz,
  ADD COLUMN stripe_schedule_id text,
  ADD CONSTRAINT fk_storage_subscriptions_pending_plan_price FOREIGN KEY (pending_plan_price_id)
    REFERENCES app.plan_prices (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT ck_storage_subscriptions_pending CHECK (
    (pending_plan_price_id IS NULL AND pending_cap_bytes IS NULL AND pending_effective_at IS NULL
      AND stripe_schedule_id IS NULL)
    OR (pending_plan_price_id IS NOT NULL AND pending_cap_bytes > 0
      AND pending_effective_at IS NOT NULL AND stripe_schedule_id IS NOT NULL)
  );

CREATE INDEX idx_storage_subscriptions_pending_plan_price_id
  ON app.storage_subscriptions (pending_plan_price_id)
  WHERE pending_plan_price_id IS NOT NULL;

COMMENT ON COLUMN app.storage_subscriptions.pending_plan_price_id IS
  'The tier the add-on moves to at its next renewal (000224); applied by the webhook pipeline when the Stripe subscription moves to that price.';
COMMENT ON COLUMN app.storage_subscriptions.stripe_schedule_id IS
  'The Stripe subscription schedule holding the scheduled change (000224); released when it is undone.';

CREATE TABLE app.storage_billing_incidents (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_storage_billing_incidents PRIMARY KEY,
  school_id uuid NOT NULL,
  storage_subscription_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'overcharge',
  stripe_invoice_id text NOT NULL,
  -- What the school confirmed, what the card was charged, and what was (to be) refunded.
  expected_minor bigint NOT NULL,
  charged_minor bigint NOT NULL,
  refund_minor bigint NOT NULL,
  currency text NOT NULL,
  stripe_refund_id text,
  status text NOT NULL,
  last_error text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_storage_billing_incidents_invoice UNIQUE (stripe_invoice_id, kind),
  CONSTRAINT fk_storage_billing_incidents_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_storage_billing_incidents_storage
    FOREIGN KEY (storage_subscription_id, school_id)
    REFERENCES app.storage_subscriptions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_storage_billing_incidents_kind CHECK (kind IN ('overcharge')),
  CONSTRAINT ck_storage_billing_incidents_status CHECK (status IN ('refunded', 'needs_review')),
  CONSTRAINT ck_storage_billing_incidents_amounts CHECK (
    expected_minor >= 0 AND charged_minor > expected_minor
    AND refund_minor = charged_minor - expected_minor
  ),
  CONSTRAINT ck_storage_billing_incidents_resolved CHECK (
    (status = 'refunded') = (resolved_at IS NOT NULL)
  ),
  CONSTRAINT ck_storage_billing_incidents_timestamps CHECK (updated_at >= created_at)
);

-- The tenant scan (RLS) and the health page's per-school listing, newest first.
CREATE INDEX idx_storage_billing_incidents_school_created
  ON app.storage_billing_incidents (school_id, created_at DESC);

CREATE INDEX idx_storage_billing_incidents_storage
  ON app.storage_billing_incidents (storage_subscription_id);

COMMENT ON TABLE app.storage_billing_incidents IS
  'A storage change charged more than the school confirmed (000224): the excess refunded at once, or left for a person when the refund failed. Shown on the platform system-health page.';

REVOKE ALL PRIVILEGES ON TABLE app.storage_billing_incidents FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.storage_billing_incidents TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'storage_billing_incidents');

RESET ROLE;
