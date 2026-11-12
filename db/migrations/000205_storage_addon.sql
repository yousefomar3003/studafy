-- The paid storage add-on: a school buys more file storage than the 10 GiB its subscription includes
-- (app.subscriptions.storage_cap_bytes, 000092). Two tiers, each monthly or yearly, sold on the
-- website to the school's principals and admins and billed through the same provider pipeline as the
-- AI add-on (packages/billing): its own subscription kind, its own row, its own lifecycle.
--
--   storage_100gb  100 GiB   USD 10 / month, USD 100 / year
--   storage_1tb      1 TiB   USD 49 / month, USD 490 / year
--
-- The USD prices are the amounts the product owner set (2026-11-12). Other currencies are added as
-- more app.plan_prices rows for the same plans; a school is offered its own currency when one exists
-- and USD otherwise. As with every plan, a price is chargeable through Stripe only once
-- POST /api/admin/subscriptions/sync-prices has created it there.
--
-- The cap a school is held to is never written by billing: the quota check takes the larger of the
-- subscription's included cap and the cap of a live storage add-on, so an add-on that lapses, is
-- canceled or is closed after its grace period simply stops counting. Nothing is ever deleted; a
-- school over its cap keeps every file and can read them, and only new uploads are refused.

SET ROLE studafy_admin;

-- Not used anywhere in this migration: a new enum value cannot be used in the transaction that adds
-- it.
ALTER TYPE app.billing_subscription_type ADD VALUE IF NOT EXISTS 'storage';

-- 1 -- The catalog. audience stays NULL: these are not license tiers (the console lists only plans
-- with an audience), and they carry no features.

INSERT INTO app.plans (code, display_name, description, is_active)
VALUES
  ('storage_100gb', 'Storage 100 GB', 'Raises the school''s file storage to 100 GB.', true),
  ('storage_1tb', 'Storage 1 TB', 'Raises the school''s file storage to 1 TB.', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor, is_active)
SELECT p.id, c.id, v.billing_interval::app.billing_interval, v.amount_minor, true
FROM (
  VALUES
    ('storage_100gb', 'monthly', 1000),
    ('storage_100gb', 'yearly', 10000),
    ('storage_1tb', 'monthly', 4900),
    ('storage_1tb', 'yearly', 49000)
) AS v (plan_code, billing_interval, amount_minor)
JOIN app.plans AS p ON p.code = v.plan_code
JOIN app.currencies AS c ON c.code = 'USD'
ON CONFLICT ON CONSTRAINT uq_plan_prices_plan_currency_interval DO NOTHING;

-- 2 -- One storage add-on per school. Buying again after it ended starts a new lifecycle on the same
-- row, as a student's AI add-on does; changing tier changes plan_price_id and cap_bytes in place.

CREATE TABLE app.storage_subscriptions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_storage_subscriptions PRIMARY KEY,
  school_id uuid NOT NULL,
  -- The price being paid; it names the tier. NULL only if that price row is ever removed.
  plan_price_id uuid,
  -- The storage this tier gives, in bytes. Copied from the tier when bought or changed, so a later
  -- catalog edit never shrinks what a school already paid for.
  cap_bytes bigint NOT NULL,
  status app.subscription_status NOT NULL DEFAULT 'trialing',
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  stripe_subscription_id text,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  tap_card_id text,
  tap_payment_agreement_id text,
  grace_period_ends_at timestamptz,
  dunning_email_stage smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_storage_subscriptions_school UNIQUE (school_id),
  CONSTRAINT uq_storage_subscriptions_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_storage_subscriptions_stripe_subscription_id UNIQUE (stripe_subscription_id),
  CONSTRAINT fk_storage_subscriptions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_storage_subscriptions_plan_price FOREIGN KEY (plan_price_id)
    REFERENCES app.plan_prices (id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT ck_storage_subscriptions_cap_bytes CHECK (cap_bytes > 0),
  CONSTRAINT ck_storage_subscriptions_period CHECK (current_period_end > current_period_start),
  CONSTRAINT ck_storage_subscriptions_tap_saved_card CHECK (
    (tap_card_id IS NULL) = (tap_payment_agreement_id IS NULL)
  ),
  CONSTRAINT ck_storage_subscriptions_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_storage_subscriptions_plan_price_id ON app.storage_subscriptions (plan_price_id);

COMMENT ON TABLE app.storage_subscriptions IS
  'A school''s paid storage add-on (000205): the tier (plan_price_id, cap_bytes) and its billing lifecycle. While live, the school''s upload cap is the larger of this cap and app.subscriptions.storage_cap_bytes.';

REVOKE ALL PRIVILEGES ON TABLE app.storage_subscriptions FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.storage_subscriptions TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'storage_subscriptions');

RESET ROLE;
