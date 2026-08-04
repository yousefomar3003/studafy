-- studafy:migration transaction=off
--
-- Malware scanning of materials (file-scan queue).
--
-- Adds two lifecycle states to app.material_ingest_status:
--
--   scanning     — confirm moved the material here from 'uploaded'; the file-scan worker owns
--                  this state and flips it to a terminal value. Nothing may serve the object
--                  while a material is 'scanning' (or 'quarantined'/'failed').
--   quarantined  — ClamAV returned an infected verdict. The object was copied to the
--                  `quarantine/` bucket prefix and removed from `permanent/`; the material is
--                  never served and the uploader was notified.
--
-- Clean scans move the material to 'ready' (the existing "available" state). Unscannable
-- materials stay 'failed' — the existing terminal failure state, written by the worker's
-- fail-closed path after retries are exhausted.
--
-- Also adds two app.notification_type values (MATERIAL_SCAN_QUARANTINED and
-- MATERIAL_SCAN_FAILED), mirroring NOTIFICATION_TYPES in packages/constants label-for-label the
-- way 000017 states that enum mirrors the constant.
--
-- transaction=off is required, not stylistic. PostgreSQL forbids USING a new enum value in the
-- same transaction that added it, and the migration runner sends each migration file as a single
-- query — which PostgreSQL wraps in one implicit transaction — so an ADD VALUE and an in-file
-- use of the new value cannot coexist in one migration. This file only ADDs values; the
-- ingest-lifecycle CHECK that references 'scanning' and 'quarantined' lands in
-- 000089_add_material_ingest_lifecycle_check.sql, where the values are already committed. The
-- runner requires non-transactional migrations be idempotent: the ADD VALUE IF NOT EXISTS guards
-- satisfy that, so re-running this is a no-op rather than a duplicate_object error.

SET ROLE studafy_admin;

ALTER TYPE app.material_ingest_status ADD VALUE IF NOT EXISTS 'scanning';
ALTER TYPE app.material_ingest_status ADD VALUE IF NOT EXISTS 'quarantined';

ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'MATERIAL_SCAN_QUARANTINED';
ALTER TYPE app.notification_type ADD VALUE IF NOT EXISTS 'MATERIAL_SCAN_FAILED';

RESET ROLE;
