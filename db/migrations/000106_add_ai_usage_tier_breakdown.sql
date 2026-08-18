-- Adds per-tier token breakdown to ai_usage_meters (ST-155 metrics dashboard).
--
-- The durable ledger previously stored only total_tokens, forcing the metrics dashboard to estimate
-- provider cost using an empirical blended rate. This migration adds small_tokens and large_tokens
-- columns so the dashboard can compute per-tier cost directly — reconciling within ~1% of provider
-- billing instead of ~5%.
--
-- Depends on: 000021 (ai_usage_meters table, upsert_ai_usage_tokens function).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.ai_usage_meters
  ADD COLUMN small_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN large_tokens bigint NOT NULL DEFAULT 0;

ALTER TABLE app.ai_usage_meters
  ADD CONSTRAINT ck_ai_usage_meters_small_tokens CHECK (small_tokens >= 0),
  ADD CONSTRAINT ck_ai_usage_meters_large_tokens CHECK (large_tokens >= 0);

-- ---------------------------------------------------------------------------------------------------
-- 2. Replace upsert function with tier-aware version
-- ---------------------------------------------------------------------------------------------------

-- Drop old grants first (function signature changes).
REVOKE ALL ON FUNCTION app.upsert_ai_usage_tokens(uuid, uuid, bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.upsert_ai_usage_tokens(
  p_student_id uuid,
  p_ai_subscription_id uuid,
  p_tokens bigint,
  p_small_tokens bigint DEFAULT 0,
  p_large_tokens bigint DEFAULT 0
) RETURNS bigint
  LANGUAGE sql
  SET search_path = pg_catalog
  AS $$
  INSERT INTO app.ai_usage_meters (school_id, student_id, ai_subscription_id, total_tokens, small_tokens, large_tokens)
  VALUES (
    current_setting('app.school_id')::uuid,
    p_student_id,
    p_ai_subscription_id,
    p_tokens,
    p_small_tokens,
    p_large_tokens
  )
  ON CONFLICT (school_id, student_id, ai_subscription_id)
  DO UPDATE SET
    total_tokens = app.ai_usage_meters.total_tokens + EXCLUDED.total_tokens,
    small_tokens = app.ai_usage_meters.small_tokens + EXCLUDED.small_tokens,
    large_tokens = app.ai_usage_meters.large_tokens + EXCLUDED.large_tokens,
    updated_at = CURRENT_TIMESTAMP
  RETURNING total_tokens;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 3. Backfill existing rows (60/40 large/small default for historical data)
-- ---------------------------------------------------------------------------------------------------

UPDATE app.ai_usage_meters
SET
  small_tokens = FLOOR(total_tokens * 0.4),
  large_tokens = total_tokens - FLOOR(total_tokens * 0.4)
WHERE small_tokens = 0 AND large_tokens = 0 AND total_tokens > 0;

-- ---------------------------------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION app.upsert_ai_usage_tokens(uuid, uuid, bigint, bigint, bigint) TO studafy_app;

RESET ROLE;
