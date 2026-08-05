-- Replaces ck_materials_ingest_lifecycle (000011) so the scan states added by
-- 000088_add_material_scan_states.sql obey the same rules as the states they sit beside:
-- 'scanning' is mid-flight like 'uploaded'/'processing' (no error, no ingest stamp), and
-- 'quarantined' is terminal-failed like 'failed' (error set, no ingest stamp). Without this,
-- confirm's flip to 'scanning' and the worker's flip to 'quarantined' would both violate the
-- constraint.
--
-- This is a separate migration from 000088 on purpose. The CHECK references the new enum values,
-- and PostgreSQL forbids using a new enum value in the same transaction that added it — the
-- runner wraps this file in BEGIN/COMMIT, which is fine because 000088 already committed the
-- values. Re-running this is safe: the DROP is guarded by IF EXISTS and the ADD rebuilds the
-- constraint to the same definition, which is a no-op.

SET ROLE studafy_admin;

ALTER TABLE app.materials DROP CONSTRAINT IF EXISTS ck_materials_ingest_lifecycle;

ALTER TABLE app.materials ADD CONSTRAINT ck_materials_ingest_lifecycle CHECK (
  (ingest_status IN ('uploaded', 'processing', 'scanning')
    AND ingest_error IS NULL AND ingested_at IS NULL)
  OR (ingest_status = 'ready' AND ingest_error IS NULL AND ingested_at IS NOT NULL)
  OR (ingest_status IN ('failed', 'quarantined')
    AND ingest_error IS NOT NULL AND ingested_at IS NULL)
);

RESET ROLE;
