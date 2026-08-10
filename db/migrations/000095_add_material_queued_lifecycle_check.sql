-- Replaces ck_materials_ingest_lifecycle (000089) so the 'queued' state added by
-- 000094_add_material_queued_state.sql obeys the same rules as the states it sits beside:
-- 'queued' is mid-flight like 'uploaded'/'processing'/'scanning' (no error, no ingest stamp),
-- sitting between a clean scan and the ai-ingestion worker's claim. Without this, the scan
-- worker's flip to 'queued' and the API's re-ingest flip would both violate the constraint.
--
-- This is a separate migration from 000094 on purpose. The CHECK references the new enum value,
-- and PostgreSQL forbids using a new enum value in the same transaction that added it — the
-- runner wraps this file in BEGIN/COMMIT, which is fine because 000094 already committed the
-- value. Re-running this is safe: the DROP is guarded by IF EXISTS and the ADD rebuilds the
-- constraint to the same definition, which is a no-op.

SET ROLE studafy_admin;

ALTER TABLE app.materials DROP CONSTRAINT IF EXISTS ck_materials_ingest_lifecycle;

ALTER TABLE app.materials ADD CONSTRAINT ck_materials_ingest_lifecycle CHECK (
  (ingest_status IN ('uploaded', 'processing', 'scanning', 'queued')
    AND ingest_error IS NULL AND ingested_at IS NULL)
  OR (ingest_status = 'ready' AND ingest_error IS NULL AND ingested_at IS NOT NULL)
  OR (ingest_status IN ('failed', 'quarantined')
    AND ingest_error IS NOT NULL AND ingested_at IS NULL)
);

RESET ROLE;
