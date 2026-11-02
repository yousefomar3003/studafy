-- Storage quota metering: the tenant ceiling on object-storage bytes and the per-school meter
-- that enforces it.
--
-- The ceiling lives on app.subscriptions.storage_cap_bytes, mirroring student_cap (000038):
-- the cap is per-tenant, copied from the plan's offering at provisioning, and read at enforcement
-- time from the subscription row. The meter is one row per school in app.storage_usage_meters,
-- the same shape as app.ai_usage_meters (000021): an atomic add/replace pair of functions keeps
-- concurrent confirmations from losing bytes, and RLS keeps every write tenant-scoped.
--
-- The meter is an event-driven counter (incremented at permanent/ promotion, corrected to bucket
-- inventory by the daily reconciliation job) -- see the quota service header for the full model.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Ceiling on the subscription row
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.subscriptions
  ADD COLUMN storage_cap_bytes bigint NOT NULL DEFAULT 10737418240
    CHECK (storage_cap_bytes > 0);

-- ---------------------------------------------------------------------------------------------------
-- 2. Meter table
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.storage_usage_meters (
  school_id  uuid NOT NULL,
  bytes_used bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT pk_storage_usage_meters PRIMARY KEY (school_id),
  CONSTRAINT fk_storage_usage_meters_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_storage_usage_meters_bytes_used CHECK (bytes_used >= 0),
  CONSTRAINT ck_storage_usage_meters_timestamps CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------------------------------
-- 3. Atomic meter functions
-- ---------------------------------------------------------------------------------------------------

-- Add (or subtract, with a negative p_bytes) to the school's running total under row-level locking.
-- The floor at zero makes release idempotent against a counter that reconciliation already lowered.
-- Reads the acting school from the tenant GUC, exactly like app.upsert_ai_usage_tokens (000021).
CREATE FUNCTION app.add_storage_usage(p_bytes bigint) RETURNS bigint
  LANGUAGE sql
  SET search_path = pg_catalog
  AS $$
  INSERT INTO app.storage_usage_meters (school_id, bytes_used)
  VALUES (current_setting('app.school_id')::uuid, GREATEST(0, p_bytes))
  ON CONFLICT (school_id)
  DO UPDATE SET
    bytes_used = GREATEST(0, app.storage_usage_meters.bytes_used + p_bytes),
    updated_at = CURRENT_TIMESTAMP
  RETURNING bytes_used;
$$;

-- Replace the school's total outright. Reconciliation uses this because it recomputes the whole
-- bucket footprint; adding a delta on top of a stale count would never converge.
CREATE FUNCTION app.set_storage_usage(p_bytes bigint) RETURNS bigint
  LANGUAGE sql
  SET search_path = pg_catalog
  AS $$
  INSERT INTO app.storage_usage_meters (school_id, bytes_used)
  VALUES (current_setting('app.school_id')::uuid, GREATEST(0, p_bytes))
  ON CONFLICT (school_id)
  DO UPDATE SET
    bytes_used = GREATEST(0, EXCLUDED.bytes_used),
    updated_at = CURRENT_TIMESTAMP
  RETURNING bytes_used;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.storage_usage_meters FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.storage_usage_meters TO studafy_app;

REVOKE ALL ON FUNCTION app.add_storage_usage(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_storage_usage(bigint) TO studafy_app;

REVOKE ALL ON FUNCTION app.set_storage_usage(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_storage_usage(bigint) TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'storage_usage_meters');

RESET ROLE;
