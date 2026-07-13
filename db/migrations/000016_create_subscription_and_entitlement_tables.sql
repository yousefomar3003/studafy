-- Creates the platform billing-subscription and AI-entitlement model: app.subscriptions
-- (one current billing subscription per school), app.ai_subscriptions (one current AI-feature
-- entitlement per student), and app.billing_events (an append-only, deduplicated log of inbound
-- payment-provider webhook deliveries).
--
-- Depends on 000004 (app.schools, app.plans), 000006 (app.apply_tenant_isolation), and 000008
-- (app.students). Follows 000015 (finance read-model and ERPNext id-mapping tables) only in ticket
-- ordering, not in schema: subscriptions/entitlements are the SaaS billing-provider side of the
-- platform (Studafy's own plan a school pays for), while 000015's invoice/payment/fee-schedule
-- cache mirrors ERPNext's school-fee ledger for students. Neither references the other; a shared
-- provider (e.g. Stripe) invoicing a school for its Studafy plan is a distinct concern from ERPNext
-- invoicing a family for school fees, so no foreign key crosses between them here.
--
-- app.subscriptions and app.ai_subscriptions each hold *current state only*, one row per school (or
-- per student), updated in place as the provider's webhooks report plan changes, renewals,
-- cancellations, or lapses -- the same current-state-cache shape 000015 already established for
-- ERPNext documents, not a versioned history table. History is exactly what app.billing_events
-- already is: the ordered, deduplicated record of every provider event received. Modeling
-- subscriptions as a row-per-change history table in addition would duplicate that log and invite
-- the two copies to drift (the normalization standard's warning against duplicated, derivable facts).
--
-- app.billing_events is deliberately global, not school-owned: a webhook delivery must be
-- deduplicated by (provider, provider_event_id) before its payload is even parsed enough to know
-- which school or student it concerns, so it cannot carry a NOT NULL school_id and cannot receive
-- app.apply_tenant_isolation (which requires exactly that). It is not one of the six tables
-- `db/policies/tenant_isolation.sql` already classifies as global-and-unprotected (schools, plans,
-- plan_prices, countries, currencies, platform_settings), because unlike that mostly-public
-- reference data, this table carries externally-sourced, potentially sensitive payment-provider
-- payloads and must not be broadly queryable by the tenant-facing runtime role. It therefore gets a
-- third treatment this schema has not needed before: RLS enabled and FORCE-d (this repo's uniform
-- defense-in-depth posture for every RLS-bearing table -- see 000006 and the finance migration)
-- with a single policy scoped to `studafy_admin` only, rather than the canonical `tenant_isolation`
-- policy's PUBLIC-plus-school_id shape. The default per-role CRUD grant that
-- `ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin ... GRANT ... TO studafy_app` (000002) would
-- otherwise hand `studafy_app` is explicitly revoked here, the same way 000004 narrowed it for the
-- six pre-existing global tables. Processing an inbound webhook is therefore a controlled-maintenance
-- operation performed under `studafy_admin`, the same role migrations and other administrative
-- writes already use -- not a new role, since this repository's role model
-- (`docs/database/role-model.md`) deliberately keeps to exactly two.

SET ROLE studafy_admin;

CREATE TYPE app.subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'expired');

-- One row per school: its current Studafy plan, billing status, and billing period. Plan changes,
-- renewals, and status transitions update this row in place; app.billing_events retains the history
-- of the provider events that drove each transition. See docs/database/subscriptions-data-model.md
-- for the full state machine.
CREATE TABLE app.subscriptions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_subscriptions PRIMARY KEY,
  school_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  status app.subscription_status NOT NULL DEFAULT 'trialing',
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_subscriptions_school UNIQUE (school_id),
  CONSTRAINT fk_subscriptions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_subscriptions_period CHECK (current_period_end > current_period_start),
  CONSTRAINT ck_subscriptions_timestamps CHECK (updated_at >= created_at)
);

-- One row per student: their current AI-feature entitlement. Deliberately has no plan_id -- the
-- ticket's own field list distinguishes it from app.subscriptions by exactly this ("student-level,
-- status, requires school link"); an AI entitlement is a single add-on toggle with its own period,
-- not a school-plan choice, so a plan reference is not invented here. student_id's foreign key is
-- composite (student_id, school_id) -> app.students (id, school_id), the same pattern 000015 uses
-- for invoice_cache.student_id/payment_cache.student_id, so a row can never point to a student
-- outside its own school_id even if application code supplied a mismatched pair.
CREATE TABLE app.ai_subscriptions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_subscriptions PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  status app.subscription_status NOT NULL DEFAULT 'trialing',
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ai_subscriptions_school_student UNIQUE (school_id, student_id),
  CONSTRAINT fk_ai_subscriptions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_subscriptions_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_subscriptions_period CHECK (current_period_end > current_period_start),
  CONSTRAINT ck_ai_subscriptions_timestamps CHECK (updated_at >= created_at)
);

-- Global, append-only webhook intake log. No school_id: a delivery is deduplicated by
-- (provider, provider_event_id) alone, before its payload is interpreted well enough to attribute it
-- to one school or student. payload is JSONB because it is a genuinely external, provider-owned
-- payload this migration does not model further (the same justification 000015 documents for
-- erpnext_payload) -- this table's own job ends at "have we already recorded this event id."
CREATE TABLE app.billing_events (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_billing_events PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_billing_events_provider_event_id UNIQUE (provider, provider_event_id),
  CONSTRAINT ck_billing_events_provider CHECK (provider = btrim(provider) AND provider <> ''),
  CONSTRAINT ck_billing_events_provider_event_id CHECK (
    provider_event_id = btrim(provider_event_id) AND provider_event_id <> ''
  ),
  CONSTRAINT ck_billing_events_event_type CHECK (
    event_type = btrim(event_type) AND event_type <> ''
  ),
  CONSTRAINT ck_billing_events_timestamps CHECK (updated_at >= created_at)
);

-- Backs the plan foreign key's parent update/delete check (mirrors idx_plan_prices_currency_id in
-- 000004, a single-column index for the same reason: a tenant table referencing a global one).
-- uq_subscriptions_school already indexes school_id; uq_ai_subscriptions_school_student already
-- indexes (school_id, student_id) for both the school and composite student foreign keys; and
-- uq_billing_events_provider_event_id already indexes the only documented billing_events access
-- pattern (idempotent lookup by provider + event id), so no further indexes are added.
CREATE INDEX idx_subscriptions_plan_id ON app.subscriptions (plan_id);

REVOKE ALL PRIVILEGES ON TABLE app.subscriptions, app.ai_subscriptions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.subscriptions, app.ai_subscriptions TO studafy_app;

REVOKE ALL ON TYPE app.subscription_status FROM PUBLIC;
GRANT USAGE ON TYPE app.subscription_status TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'subscriptions');
SELECT app.apply_tenant_isolation('app', 'ai_subscriptions');

-- billing_events: global-admin scoped. Narrow the ST-031 default CRUD grant
-- (000002's `ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin ... GRANT ... TO studafy_app`) all the
-- way to nothing, then force RLS with a single policy naming `studafy_admin` explicitly, so access
-- depends on both the grant and the policy rather than either alone.
REVOKE ALL PRIVILEGES ON TABLE app.billing_events FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE app.billing_events FROM studafy_app;

ALTER TABLE app.billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.billing_events FORCE ROW LEVEL SECURITY;

CREATE POLICY global_admin_only ON app.billing_events
  AS PERMISSIVE FOR ALL TO studafy_admin USING (true) WITH CHECK (true);

RESET ROLE;
