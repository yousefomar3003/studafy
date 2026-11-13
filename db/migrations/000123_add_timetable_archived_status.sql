-- studafy:migration transaction=off
--
-- Add 'archived' to app.timetable_version_status: the state a live (approved) timetable moves to
-- when a newer version of the same term is published. uq_timetable_versions_one_approved_per_term
-- keeps exactly one approved version per term; archiving the previous one in the same transaction
-- as the approval is what lets a term's timetable be republished while keeping the old one as
-- history. The transition and CHECK rules for the new state are in 000124, because that migration
-- has to reference the new value.
--
-- transaction=off is required, not stylistic: PostgreSQL forbids USING a new enum value in the same
-- transaction that added it, and the migration runner wraps every transactional migration in
-- BEGIN/COMMIT. IF NOT EXISTS keeps a re-run a no-op rather than a duplicate_object error, which the
-- runner requires of every non-transactional migration.

SET ROLE studafy_admin;

ALTER TYPE app.timetable_version_status ADD VALUE IF NOT EXISTS 'archived';

RESET ROLE;
