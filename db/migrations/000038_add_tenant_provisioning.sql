-- ST-089: Tenant provisioning service & ERPNext auto-bootstrap.
--
-- Adds the provisioning lifecycle: a provisioning_status column on schools and subscriptions
-- to track the multi-step pipeline, trial limit columns on subscriptions to enforce the 50-student
-- cap and 14-day window, and an erpnext_site_configs table that maps each school to its isolated
-- ERPNext site and company.
--
-- Idempotent: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so re-runs are safe.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- Enum: provisioning status
-- ---------------------------------------------------------------------------

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'provisioning_status' AND typnamespace = 'app'::regnamespace) THEN
    CREATE TYPE app.provisioning_status AS ENUM (
      'pending', 'in_progress', 'completed', 'failed'
    );
  END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- Alter app.subscriptions — trial limits + provisioning status
-- ---------------------------------------------------------------------------

ALTER TABLE app.subscriptions
  ADD COLUMN IF NOT EXISTS student_cap integer NOT NULL DEFAULT 50
    CHECK (student_cap > 0),
  ADD COLUMN IF NOT EXISTS trial_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS provisioning_status app.provisioning_status NOT NULL DEFAULT 'pending';

-- ---------------------------------------------------------------------------
-- New table: app.erpnext_site_configs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.erpnext_site_configs (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id           uuid NOT NULL REFERENCES app.schools(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  site_name           text NOT NULL,
  company_name        text NOT NULL,
  company_abbr        text NOT NULL,
  erpnext_site_id     text,
  erpnext_company_id  text,
  status              app.provisioning_status NOT NULL DEFAULT 'pending',
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_erpnext_site_configs_school UNIQUE (school_id),
  CONSTRAINT uq_erpnext_site_configs_site_name UNIQUE (site_name)
);

-- Ownership, RLS, and grants -----------------------------------------------

ALTER TABLE app.erpnext_site_configs OWNER TO studafy_admin;

ALTER TABLE app.erpnext_site_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.erpnext_site_configs FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON app.erpnext_site_configs TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'erpnext_site_configs');

-- ---------------------------------------------------------------------------
-- Add provisioning_status to app.schools
-- ---------------------------------------------------------------------------

ALTER TABLE app.schools
  ADD COLUMN IF NOT EXISTS provisioning_status app.provisioning_status NOT NULL DEFAULT 'pending';

RESET ROLE;
