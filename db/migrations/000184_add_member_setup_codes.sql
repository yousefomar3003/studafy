-- One-time setup codes replace the shared default member password (QA-11, finding F-02).
--
-- Until now a member with no stored hash signed in with the platform-wide default password and chose
-- their own in the same request. Member codes are sequential, so anyone could claim any account that
-- had never been used. From here a member with no password can only sign in with a setup code: a
-- random per-member secret (80 bits) that an administrator issues, that expires after 14 days and
-- that is consumed when the member sets their password. The API returns it once, to the issuing
-- administrator; only its SHA-256 digest is stored. A high-entropy random code needs no slow hash.
--
-- Rollout: no backfill. Accounts that never signed in keep a NULL password_hash and no setup code,
-- so the old default password stops working the moment this ships and they cannot sign in until
-- their school issues them a code (docs/runbooks/member-setup-codes.md).

SET ROLE studafy_admin;

ALTER TABLE app.member_credentials
  ADD COLUMN setup_code_hash text,
  ADD COLUMN setup_code_expires_at timestamptz,
  ADD CONSTRAINT ck_member_credentials_setup_code CHECK (
    (setup_code_hash IS NULL) = (setup_code_expires_at IS NULL)
    AND (setup_code_hash IS NULL OR setup_code_hash ~ '^[0-9a-f]{64}$')
  ),
  -- A code only exists to set the first password; storing a password consumes it.
  ADD CONSTRAINT ck_member_credentials_setup_code_unclaimed CHECK (
    setup_code_hash IS NULL OR password_hash IS NULL
  );

COMMENT ON COLUMN app.member_credentials.password_hash IS
  'argon2id hash of the member''s password. NULL: no password yet; sign-in needs a live setup code (000184).';
COMMENT ON COLUMN app.member_credentials.setup_code_hash IS
  'SHA-256 hex digest of the one-time setup code an administrator issued (000184). Cleared when used.';
COMMENT ON COLUMN app.member_credentials.setup_code_expires_at IS
  'When the setup code stops working.';
COMMENT ON TABLE app.member_credentials IS
  'Member-code sign-in secrets (000141, 000184): argon2id password hash or a one-time setup code, and lockout state.';

RESET ROLE;
