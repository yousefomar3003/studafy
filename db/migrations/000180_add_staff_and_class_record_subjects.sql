-- studafy:migration transaction=off
--
-- Adds 'staff' and 'class' to app.record_subject_kind (docs/modules/student-records.md "Staff and
-- class records"), so a school can define its own fields for staff members (a qualification, a
-- contract type) and for classes (homeroom notes, a bus group) the way it already can for students
-- and parents.
--
-- transaction=off is required, not stylistic: PostgreSQL forbids using a new enum value in the
-- transaction that added it, and the runner wraps every transactional migration in BEGIN/COMMIT.
-- This file only adds the values; the columns, CHECKs and row-scope policy that use them are
-- 000181, where the values are already committed. ADD VALUE IF NOT EXISTS keeps a re-run a no-op,
-- as the runner requires of non-transactional migrations.

SET ROLE studafy_admin;

ALTER TYPE app.record_subject_kind ADD VALUE IF NOT EXISTS 'staff';
ALTER TYPE app.record_subject_kind ADD VALUE IF NOT EXISTS 'class';

RESET ROLE;
