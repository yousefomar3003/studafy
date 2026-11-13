-- School email verification (ST-email-verification).
--
-- Adds infrastructure for email verification during school self-registration:
-- 1. email_verified_at on app.schools — NULL until the school contact verifies their email.
-- 2. email_verification_token_hash + email_verification_expires_at — the pending verification
--    token (SHA-256 hash). Both are NULL after verification or when no token is active.
-- 3. A CHECK constraint enforces that token_hash and expires_at are both NULL or both set.
--
-- After email verification, the school status moves from 'registered' to 'active' (trial),
-- which unblocks admin invitation activation via evaluateInvitationState.

SET ROLE studafy_admin;

-- 1. Add verification columns to app.schools.
--    Nullable first: existing rows (the demo school) have no verification token.
ALTER TABLE app.schools
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN email_verification_token_hash bytea,
  ADD COLUMN email_verification_expires_at timestamptz;

-- 2. CHECK: token_hash and expires_at must be both NULL or both NOT NULL.
ALTER TABLE app.schools ADD CONSTRAINT ck_schools_email_verification CHECK (
  (email_verification_token_hash IS NULL AND email_verification_expires_at IS NULL)
  OR
  (email_verification_token_hash IS NOT NULL AND email_verification_expires_at IS NOT NULL)
);

-- 3. Index for token lookup during verification (global table, no RLS).
CREATE INDEX idx_schools_verification_token
  ON app.schools (email_verification_token_hash)
  WHERE email_verification_token_hash IS NOT NULL;

RESET ROLE;
