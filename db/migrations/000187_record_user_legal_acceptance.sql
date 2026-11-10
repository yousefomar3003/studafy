-- Record each user's acceptance of the Terms of Service and the Privacy Policy.
--
-- Every person who uses Studafy now accepts the current Terms of Service and confirms they have read
-- the current Privacy Policy before they can do anything else. The versions are the documents'
-- `Last updated` dates (packages/constants/src/legal.ts, LEGAL_DOCUMENT_VERSIONS). When either date
-- moves on, the person is asked again at their next sign-in: token minting compares these columns
-- with the current versions and sets the `legal_acceptance_pending` claim, and the
-- legalAcceptanceGuard middleware confines such a session to reading its profile, accepting, managing
-- its own deletion and signing out.
--
-- Columns on app.users rather than a table, like the deletion schedule (000143): one current
-- acceptance per account, read next to the rest of the user row when a token is minted. The full
-- history is in the audit log (POST /api/account/legal-acceptance writes an `update` row on users).
-- A person with accounts at several schools accepts once per account, because each school's account
-- is a separate user.
--
-- Nullable: existing users have accepted nothing yet, and are asked at their next sign-in.

SET ROLE studafy_admin;

ALTER TABLE app.users
  ADD COLUMN terms_version text,
  ADD COLUMN privacy_version text,
  ADD COLUMN legal_accepted_at timestamptz,
  ADD CONSTRAINT ck_users_legal_acceptance CHECK (
    (terms_version IS NULL AND privacy_version IS NULL AND legal_accepted_at IS NULL)
    OR (
      terms_version ~ '^\d{4}-\d{2}-\d{2}$'
      AND privacy_version ~ '^\d{4}-\d{2}-\d{2}$'
      AND legal_accepted_at IS NOT NULL
    )
  );

COMMENT ON COLUMN app.users.terms_version IS
  'Last-updated date of the Terms of Service the user most recently accepted (000187).';
COMMENT ON COLUMN app.users.privacy_version IS
  'Last-updated date of the Privacy Policy the user most recently confirmed reading (000187).';
COMMENT ON COLUMN app.users.legal_accepted_at IS
  'When the user accepted terms_version and privacy_version (000187).';

RESET ROLE;
