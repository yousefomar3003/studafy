-- Thumbnail and first-page preview derivation for materials (derivations queue).
--
-- The derivations worker (apps/workers/src/queues/derivations) generates a small thumbnail for
-- rasters and PDFs, plus a higher-resolution first-page preview for PDFs, and records the resulting
-- S3 keys here. A NULL key is the graceful-degradation contract: the material list shows the
-- per-type icon until a key is set, so a derivation failure (or an unsupported type such as PPTX)
-- degrades to the icon rather than blocking the material.
--
-- The keys follow the canonical storage scheme `<category>/<schoolId>/<objectId>/<filename>` under
-- `permanent/` (see apps/api/src/lib/storage/keys.ts), with the material id as the object id — a
-- uuid is a safe segment, and it is unique where the original's filename slug is not. The CHECK
-- mirrors ck_materials_storage_key (000011), pinning a derived key to its own row's school_id so a
-- row can never claim an object from another tenant's prefix. No new enum values, so this stays a
-- plain transactional migration.

SET ROLE studafy_admin;

ALTER TABLE app.materials
  ADD COLUMN thumbnail_key text,
  ADD COLUMN preview_key text;

ALTER TABLE app.materials ADD CONSTRAINT ck_materials_derivation_keys CHECK (
  (thumbnail_key IS NULL OR thumbnail_key ~ ('^permanent/' || school_id::text || '/[^/]+/[^/]+$'))
  AND (preview_key IS NULL OR preview_key ~ ('^permanent/' || school_id::text || '/[^/]+/[^/]+$'))
);

RESET ROLE;
