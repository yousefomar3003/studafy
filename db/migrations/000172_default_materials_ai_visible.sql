-- Materials are AI-visible by default.
--
-- Whether a student can use Studafy AI on a material is decided by that student's own AI grants
-- (subscription, school seat or trial; see 000161 and apps/api/src/modules/features/resolve.ts),
-- not by the teacher who uploaded it. The mobile teacher app therefore no longer offers the
-- per-material "Allow Studafy AI" switch, and every new material goes through AI ingestion after
-- its clean scan: the scan worker hands a clean material to the ai-ingestion queue only when
-- ai_visible is true (apps/workers/src/queues/scan/scan-material.worker.ts).
--
-- The backfill only covers materials that have not been scanned yet ('uploaded', 'scanning'), so
-- their pending scan picks the new value up. A material already 'ready' without AI is left alone on
-- purpose: re-ingesting it moves it through 'queued' and 'processing', and downloads are served
-- only from 'ready' (apps/api/src/modules/storage/download-service.ts), so a mass flip would hide
-- every such material from students until its ingestion finished -- and for good if it failed.
--
-- Per-school loop rather than one UPDATE: tenant_isolation is FORCED on app.materials, so a single
-- statement under the sentinel context would match zero rows and silently no-op (000065, 000069).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

ALTER TABLE app.materials ALTER COLUMN ai_visible SET DEFAULT true;

DO $backfill$
DECLARE
  target_school_id uuid;
BEGIN
  FOR target_school_id IN SELECT id FROM app.schools LOOP
    PERFORM set_config('app.school_id', target_school_id::text, true);

    UPDATE app.materials
    SET ai_visible = true
    WHERE ai_visible = false
      AND ingest_status IN ('uploaded', 'scanning');
  END LOOP;

  PERFORM set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
END
$backfill$;

RESET ROLE;
