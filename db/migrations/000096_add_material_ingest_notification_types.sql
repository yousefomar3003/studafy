-- studafy:migration transaction=off
--
-- Add MATERIAL_INGESTED and MATERIAL_INGEST_FAILED to app.notification_type.
--
-- Raised by the ai-ingestion worker (apps/workers/src/queues/ai-ingestion/worker.ts). The
-- teacher (usually the uploader) is told when a material finished ingestion and is ready for
-- AI search, or when it failed after retries were exhausted. Mirrors NOTIFICATION_TYPES in
-- packages/constants/src/notifications.ts label-for-label, same as every other value in this
-- enum (000017, 000057, 000082, 000088, 000090).
--
-- transaction=off is required, not stylistic: PostgreSQL forbids USING a new enum value in the
-- same transaction that added it, and the migration runner wraps every transactional migration
-- in BEGIN/COMMIT. IF NOT EXISTS keeps a re-run a no-op rather than a duplicate_object error,
-- which the runner requires of every non-transactional migration.

SET ROLE studafy_admin;

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'MATERIAL_INGESTED';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'MATERIAL_INGEST_FAILED';

RESET ROLE;
