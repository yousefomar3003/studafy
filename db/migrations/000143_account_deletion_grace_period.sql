-- Account deletion grace period.
--
-- Self-service deletion (POST /api/account/deletion, and the emailed-link flow that ends in the
-- same service) no longer detaches and erases at once. It schedules the deletion 14 days out:
-- every session is revoked straight away, and while the deletion is pending any new session the
-- person signs in to is limited to cancelling it (the `deletion_pending` access-token claim and
-- the accountDeletionGuard middleware). On the due date the maintenance worker's account-deletion
-- sweep runs what the request used to do immediately — stop AI billing, detach from the school,
-- file and enqueue the erasure.
--
-- Two columns rather than a table: there is at most one pending deletion per account, the sweep
-- and the token minting both read it next to the rest of the user row, and a new table with a
-- `school_id` column would also join the tenant export/erasure walk for no benefit. Both are set
-- together and cleared together (cancellation); the sweep leaves them set as the record of when
-- the deletion was asked for and when it ran.

SET ROLE studafy_admin;

ALTER TABLE app.users
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_due_at timestamptz,
  ADD CONSTRAINT ck_users_deletion_schedule_pair CHECK (
    (deletion_requested_at IS NULL) = (deletion_due_at IS NULL)
    AND (deletion_due_at IS NULL OR deletion_due_at > deletion_requested_at)
  );

COMMENT ON COLUMN app.users.deletion_requested_at IS
  'When the person asked to delete their account; NULL when no deletion is scheduled (000143).';
COMMENT ON COLUMN app.users.deletion_due_at IS
  'When the account-deletion sweep detaches and erases the account; cleared on cancellation (000143).';

-- The daily sweep reads only due, still-attached accounts.
CREATE INDEX idx_users_deletion_due
  ON app.users (school_id, deletion_due_at)
  WHERE deletion_due_at IS NOT NULL AND status <> 'archived';

RESET ROLE;
