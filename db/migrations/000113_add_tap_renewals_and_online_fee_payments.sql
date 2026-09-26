-- Tap renewals and online fee collection (ST-298).
--
-- 1. Saved-card columns on both subscription tables. Tap has no subscription object: Studafy renews
--    by charging the card saved on the first checkout, under the payment agreement Tap issued for it.
--    Stored per subscription, not per school customer, because the AI add-on and the school plan can
--    be paid with different cards and each renewal must charge the card that bought it.
--
-- 2. app.tap_renewal_attempts -- the renewal ledger. One row per (subscription, period, attempt),
--    claimed BEFORE the charge is sent. The unique key is what stops a re-run or a concurrent worker
--    from charging a school twice for one period; a row whose charge outcome is unknown blocks
--    further attempts for that period until a human looks at it.
--
-- 3. app.payment_provider_customers -- a payer's customer at a provider (a parent paying fees).
--    School customers stay on app.schools; this is the per-payer half of "customer per school and
--    per payer".
--
-- 4. app.online_fee_payments -- one hosted fee payment attempt for an ERPNext invoice. The amount is
--    copied from app.invoice_cache when the checkout is created and is never taken from the client.
--    Settled by the provider webhook, which then records the payment in ERPNext through the existing
--    payment forwarder (erpnext_payment_docname).
--
-- All three new tables are canonical tenant tables (school_id + tenant_isolation). They are financial
-- records and are listed under the legal hold in apps/workers/.../retention-registry.ts.

SET ROLE studafy_admin;

-- 1 -------------------------------------------------------------------------------------------------

ALTER TABLE app.subscriptions
  ADD COLUMN tap_card_id text,
  ADD COLUMN tap_payment_agreement_id text,
  ADD CONSTRAINT ck_subscriptions_tap_saved_card CHECK (
    (tap_card_id IS NULL) = (tap_payment_agreement_id IS NULL)
  );

ALTER TABLE app.ai_subscriptions
  ADD COLUMN tap_card_id text,
  ADD COLUMN tap_payment_agreement_id text,
  ADD CONSTRAINT ck_ai_subscriptions_tap_saved_card CHECK (
    (tap_card_id IS NULL) = (tap_payment_agreement_id IS NULL)
  );

-- 2 -------------------------------------------------------------------------------------------------

CREATE TYPE app.tap_renewal_status AS ENUM ('submitted', 'succeeded', 'failed', 'unknown');

CREATE TABLE app.tap_renewal_attempts (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_tap_renewal_attempts PRIMARY KEY,
  school_id uuid NOT NULL,
  subscription_type app.billing_subscription_type NOT NULL,
  subscription_id uuid NOT NULL,
  -- The period this attempt pays for, identified by its start (= the previous period's end).
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  attempt smallint NOT NULL,
  -- When the renewal job sent it, by the job's clock. Retry spacing is measured from this, not from
  -- created_at, so the job never compares its own clock against the database's.
  attempted_at timestamptz NOT NULL,
  amount_minor bigint NOT NULL,
  currency_code text NOT NULL,
  status app.tap_renewal_status NOT NULL DEFAULT 'submitted',
  tap_charge_id text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_tap_renewal_attempts_period_attempt
    UNIQUE (subscription_type, subscription_id, period_start, attempt),
  CONSTRAINT uq_tap_renewal_attempts_tap_charge_id UNIQUE (tap_charge_id),
  CONSTRAINT fk_tap_renewal_attempts_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_tap_renewal_attempts_period CHECK (period_end > period_start),
  CONSTRAINT ck_tap_renewal_attempts_attempt CHECK (attempt BETWEEN 1 AND 10),
  CONSTRAINT ck_tap_renewal_attempts_amount CHECK (amount_minor > 0),
  CONSTRAINT ck_tap_renewal_attempts_currency CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_tap_renewal_attempts_failure_reason CHECK (
    failure_reason IS NULL OR length(failure_reason) <= 2000
  ),
  CONSTRAINT ck_tap_renewal_attempts_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_tap_renewal_attempts_school ON app.tap_renewal_attempts (school_id);

-- Written only by the renewal worker, which runs as studafy_admin.
REVOKE ALL PRIVILEGES ON TABLE app.tap_renewal_attempts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE app.tap_renewal_attempts FROM studafy_app;
REVOKE ALL ON TYPE app.tap_renewal_status FROM PUBLIC;

SELECT app.apply_tenant_isolation('app', 'tap_renewal_attempts');

-- 3 -------------------------------------------------------------------------------------------------

CREATE TABLE app.payment_provider_customers (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_payment_provider_customers PRIMARY KEY,
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL,
  provider_customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_payment_provider_customers_user UNIQUE (school_id, user_id, provider),
  CONSTRAINT uq_payment_provider_customers_customer UNIQUE (provider, provider_customer_id),
  CONSTRAINT fk_payment_provider_customers_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_payment_provider_customers_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_payment_provider_customers_provider CHECK (provider IN ('stripe', 'tap')),
  CONSTRAINT ck_payment_provider_customers_customer_id CHECK (
    provider_customer_id = btrim(provider_customer_id) AND provider_customer_id <> ''
  )
);

REVOKE ALL PRIVILEGES ON TABLE app.payment_provider_customers FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE app.payment_provider_customers TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'payment_provider_customers');

-- 4 -------------------------------------------------------------------------------------------------

CREATE TYPE app.online_fee_payment_status AS ENUM ('pending', 'succeeded', 'failed');

CREATE TABLE app.online_fee_payments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_online_fee_payments PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  payer_user_id uuid NOT NULL,
  erpnext_invoice_id text NOT NULL,
  provider text NOT NULL,
  provider_session_id text,
  amount_minor bigint NOT NULL,
  currency_id uuid NOT NULL,
  status app.online_fee_payment_status NOT NULL DEFAULT 'pending',
  erpnext_payment_docname text,
  failure_reason text,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_online_fee_payments_provider_session UNIQUE (provider, provider_session_id),
  CONSTRAINT fk_online_fee_payments_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_online_fee_payments_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_online_fee_payments_payer FOREIGN KEY (payer_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_online_fee_payments_currency FOREIGN KEY (currency_id)
    REFERENCES app.currencies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_online_fee_payments_provider CHECK (provider IN ('stripe', 'tap')),
  CONSTRAINT ck_online_fee_payments_amount CHECK (amount_minor > 0),
  CONSTRAINT ck_online_fee_payments_invoice CHECK (
    erpnext_invoice_id = btrim(erpnext_invoice_id) AND erpnext_invoice_id <> ''
  ),
  CONSTRAINT ck_online_fee_payments_failure_reason CHECK (
    failure_reason IS NULL OR length(failure_reason) <= 2000
  ),
  -- A settled payment has a settlement time; a succeeded one has reached ERPNext.
  CONSTRAINT ck_online_fee_payments_settlement CHECK (
    (status = 'pending' AND settled_at IS NULL AND erpnext_payment_docname IS NULL)
    OR (status = 'succeeded' AND settled_at IS NOT NULL AND erpnext_payment_docname IS NOT NULL)
    OR (status = 'failed' AND settled_at IS NOT NULL AND erpnext_payment_docname IS NULL)
  ),
  CONSTRAINT ck_online_fee_payments_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_online_fee_payments_invoice
  ON app.online_fee_payments (school_id, erpnext_invoice_id, created_at DESC);
CREATE INDEX idx_online_fee_payments_payer ON app.online_fee_payments (school_id, payer_user_id);
CREATE INDEX idx_online_fee_payments_student ON app.online_fee_payments (student_id, school_id);
CREATE INDEX idx_online_fee_payments_currency ON app.online_fee_payments (currency_id);

REVOKE ALL PRIVILEGES ON TABLE app.online_fee_payments FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.online_fee_payments TO studafy_app;
REVOKE ALL ON TYPE app.online_fee_payment_status FROM PUBLIC;
GRANT USAGE ON TYPE app.online_fee_payment_status TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'online_fee_payments');

RESET ROLE;
