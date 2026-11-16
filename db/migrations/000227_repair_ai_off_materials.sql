-- Repair materials that turning AI off made unservable.
--
-- Until this release, PATCH /api/academics/materials/{id}/ai-visible with ai_visible = false moved
-- the material to ingest_status 'uploaded' (and cleared its ingest stamp), whatever state it was
-- in. Only a 'ready' material can be downloaded, so a clean, finished material became impossible to
-- open, and turning AI back on left it in 'uploaded' because enabling re-stages only 'ready'. The
-- abandoned-material sweep also deletes a day-old 'uploaded' row once AI is back on, taking a real
-- material with it. toggleAiVisible now keeps a material servable (see material-service.ts).
--
-- This puts back the materials whose own history shows they were servable when AI was turned
-- off: a material still in 'uploaded' whose audit trail records the AI-off toggle (the row the
-- service writes, with chunks_purged) moving it there from 'ready', 'queued' or 'processing'.
-- Every one of those had a clean malware scan. They become 'ready' again with an ingest stamp (the
-- lifecycle CHECK requires one), keeping whatever ai_visible they have now. One that is AI-visible
-- again is not re-ingested by this migration (it cannot enqueue a job); its AI chunks come back the
-- next time AI is turned off and on, or when its class's AI setting is.
--
-- A row moved to 'uploaded' from any other state ('scanning', 'failed', 'quarantined', or an
-- unconfirmed 'uploaded') is left alone: none of those was servable, and none had been scanned
-- clean.

-- Per-school loop rather than one UPDATE: tenant_isolation is FORCED on app.materials and
-- app.audit_logs, so a single statement under the sentinel context would match zero rows (000172).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

DO $repair$
DECLARE
  target_school_id uuid;
BEGIN
  FOR target_school_id IN SELECT id FROM app.schools LOOP
    PERFORM set_config('app.school_id', target_school_id::text, true);

    UPDATE app.materials AS m
    SET ingest_status = 'ready'::app.material_ingest_status,
        ingest_error = NULL,
        ingested_at = m.updated_at,
        updated_at = CURRENT_TIMESTAMP
    WHERE m.school_id = target_school_id
      AND m.ingest_status = 'uploaded'::app.material_ingest_status
      AND EXISTS (
        SELECT 1
        FROM app.audit_logs AS a
        WHERE a.school_id = m.school_id
          AND a.target_table = 'materials'
          AND a.target_id = m.id
          AND a.action = 'update'
          AND a.new_values ->> 'ingest_status' = 'uploaded'
          AND a.new_values ? 'chunks_purged'
          AND a.old_values ->> 'ingest_status' IN ('ready', 'queued', 'processing')
      );
  END LOOP;

  PERFORM set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
END
$repair$;

RESET ROLE;
