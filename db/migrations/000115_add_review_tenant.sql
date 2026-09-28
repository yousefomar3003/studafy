-- App Store / Play reviewer demo tenant (ST-303).
--
-- Apple and Google reviewers must be able to sign in to the production build as each role without an
-- external OAuth account. That access is granted to exactly one school, flagged here, and nowhere
-- else: the review-only email/password login (apps/api .../review-login-service.ts) refuses any
-- identity whose school does not carry this flag.
--
-- 1. app.schools.is_review_tenant -- the flag. Global table, no RLS, so the login path and billing
--    guard can read it before any tenant scope exists.
-- 2. At most one review tenant per database: a partial unique index over the true rows.
-- 3. A review tenant is never billable: it can never hold a Stripe or Tap customer id. The API
--    refuses checkout for it before any provider is called; this CHECK makes the invariant hold even
--    if a future code path forgets to ask.
-- 4. 'review_tenant' as an email suppression reason, so the seed can suppress the tenant's
--    undeliverable addresses and the dispatcher records those sends as suppressed instead of
--    bouncing them through SES.

SET ROLE studafy_admin;

ALTER TABLE app.schools
  ADD COLUMN is_review_tenant boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX uq_schools_review_tenant
  ON app.schools (is_review_tenant)
  WHERE is_review_tenant;

ALTER TABLE app.schools
  ADD CONSTRAINT ck_schools_review_tenant_unbillable CHECK (
    NOT is_review_tenant OR (stripe_customer_id IS NULL AND tap_customer_id IS NULL)
  );

ALTER TYPE app.email_suppression_reason ADD VALUE IF NOT EXISTS 'review_tenant';

RESET ROLE;
