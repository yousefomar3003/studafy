-- Add parent_discipline_visibility flag to school_settings.
-- Controls whether parents can view their own child's resolved discipline incidents.
-- Defaults to false (parents cannot see incidents) for existing schools.

SET ROLE studafy_admin;

ALTER TABLE app.school_settings
  ADD COLUMN parent_discipline_visibility boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app.school_settings.parent_discipline_visibility IS
  'When true, parents can view their own child''s resolved discipline incidents.';

RESET ROLE;
