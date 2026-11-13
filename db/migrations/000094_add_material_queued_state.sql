-- studafy:migration transaction=off
--
-- Adds 'queued' to app.material_ingest_status.
--
-- 'queued' is the handoff between the file-scan worker and the ai-ingestion queue (ST-161). A
-- clean scan flips the material from 'scanning' to 'queued' and enqueues an ai-ingestion job;
-- the ai-ingestion worker claims 'queued' materials (and re-claims 'processing' ones after a
-- crash) and drives them through parse -> (ocr) -> chunk -> embed to 'ready'. The API also uses
-- 'queued' as the re-ingest / re-enable staging state, so a teacher can push a 'ready' material
-- back through ingestion without a fresh upload.
--
-- Like 'processing', 'queued' is mid-flight: no error, no ingested_at. The lifecycle CHECK that
-- acknowledges it lands in 000095_add_material_queued_lifecycle_check.sql.
--
-- transaction=off is required, not stylistic: PostgreSQL forbids USING a new enum value in the
-- same transaction that added it, and the migration runner wraps every transactional migration
-- in BEGIN/COMMIT. This file only ADDs the value; the CHECK that references 'queued' is a
-- separate migration because the value must already be committed there. The runner requires
-- non-transactional migrations be idempotent: ADD VALUE IF NOT EXISTS satisfies that, so
-- re-running this is a no-op rather than a duplicate_object error.

SET ROLE studafy_admin;

ALTER TYPE app.material_ingest_status ADD VALUE IF NOT EXISTS 'queued';

RESET ROLE;
