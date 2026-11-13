-- Staging QA tenants (QA-02, docs/testing/qa-plan.md).
--
-- Testers need a bearer token for every role in two schools on staging, without database access.
-- Staging refuses the mock OAuth provider (NODE_ENV=production), so the schools flagged here carry
-- identities under a 'qa' provider that the staging-only QA email/password login
-- (apps/api .../qa-login-service.ts) authenticates. That login refuses any identity whose school does
-- not carry this flag, and the API refuses to boot with QA_LOGIN_PASSWORD set when APP_ENV is
-- production, so even a QA tenant written to a production database by mistake cannot be signed in to.
--
-- 1. app.schools.is_qa_tenant -- the flag. Global table, no RLS, so the login path can read it
--    before any tenant scope exists. Unlike is_review_tenant there is no "at most one": QA needs a
--    platform school plus two schools to test cross-tenant isolation.
-- 2. A school is never both a review and a QA tenant: the two logins answer to different secrets and
--    different environments, and a school in both would be reachable with either.
-- 3. 'qa_tenant' as an email suppression reason, so the seed can suppress the tenants' undeliverable
--    .test addresses.
--
-- QA tenants stay billable, unlike the review tenant (000116): staging billing runs against provider
-- test keys, and checkout is one of the flows QA has to exercise.

SET ROLE studafy_admin;

ALTER TABLE app.schools
  ADD COLUMN is_qa_tenant boolean NOT NULL DEFAULT false;

ALTER TABLE app.schools
  ADD CONSTRAINT ck_schools_qa_tenant_not_review_tenant CHECK (
    NOT (is_qa_tenant AND is_review_tenant)
  );

ALTER TYPE app.email_suppression_reason ADD VALUE IF NOT EXISTS 'qa_tenant';

RESET ROLE;
