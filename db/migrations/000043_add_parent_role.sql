-- Add PARENT to the user_role enum for parent-child linking (ST-094).

SET ROLE studafy_admin;

ALTER TYPE app.user_role ADD VALUE IF NOT EXISTS 'PARENT';

RESET ROLE;
