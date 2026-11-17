-- Students' own AI study sources: an assignment, or a file or photo they upload themselves.
--
-- Until now every AI study tool (summary, key concepts, quiz, flashcards, practice exam, Ask AI,
-- explain) read only a class's study materials. A student can now also pick
--
--   * one of their assignments: its title, description and instructions plus the teacher's attached
--     files, read as one source; or
--   * a file or photo of their own (a PDF / Word / PowerPoint document, or a JPEG / PNG photo of a
--     page of notes or a textbook), which is scanned for malware, OCR'd when it is a photo, and
--     ingested exactly like a teacher's material.
--
-- Both are rows of app.materials, so the whole existing pipeline -- presigned upload, ClamAV scan,
-- parse / OCR, chunk, embed, `ready`, every AI tool's loader, citations, the cascade from a deleted
-- source to everything grounded on it -- applies unchanged. What makes them different is
-- `source_kind`:
--
--   'class'      a class's study material (every row before this migration). Unchanged.
--   'personal'   a student's own upload: no class, `owner_student_id` set. PRIVATE TO THAT STUDENT:
--                the role-scope policy below shows it to its owner and nobody else -- not classmates,
--                not the class's teachers, not parents, not even the school admin (a student's own
--                notes are not an academic record, and no existing rule gives staff access to a
--                student's private study files). System work (the scan and ingestion workers, the
--                retention sweep, DSR export and erasure) runs as studafy_admin, which this
--                studafy_app policy does not bind, exactly as for every other role-scoped table.
--   'assignment' the AI source built from one assignment: `class_id` and `assignment_id` set, no
--                stored file of its own (`storage_key` NULL -- the teacher's attachments are read in
--                place by the ingestion worker, never copied), one row per assignment shared by every
--                student who can see it, rebuilt when the assignment changes (`source_fingerprint`).
--                Visible exactly like the assignment's class: its content is the teacher's.
--
-- Neither kind is ever a class material: the material list, global search, download and published
-- notification paths only ever see 'class' rows (material-service.ts, search/service.ts,
-- download-service.ts, and trg_materials_published below).
--
-- ## app.material_chunks.owner_student_id
--
-- A personal source's chunks carry their owner too, stamped by a trigger from the material (never
-- trusted from the writer), and a restrictive policy hides them from everyone else. Every AI read
-- path already joins chunks to app.materials (whose policy hides the row), so this is defence in
-- depth -- a chunk query that forgot the join still cannot leak another student's notes -- and it
-- keeps other students' personal chunks out of the retrieval legs' top-k before the join.
--
-- ## Storage
--
-- A personal upload lives under permanent/<school_id>/ai-sources/ and is counted on the school's
-- storage meter like any other upload (the daily reconciliation counts that prefix anyway). The API
-- adds a small per-student cap on top (apps/api/src/modules/ai/sources/limits.ts) so one student
-- cannot fill the school's quota.

SET ROLE studafy_admin;
SET lock_timeout = '5s';

-- Validating the new CHECKs and foreign keys scans tables whose forced RLS applies the
-- tenant_isolation predicate even to the owner (see 000198, 000210). Every existing row satisfies
-- them by construction (each is a class material: class_id and storage_key were NOT NULL, the new
-- columns are NULL and source_kind takes its 'class' default), so the nil tenant's empty scan is
-- exact.
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

-- 1. Columns and shape ------------------------------------------------------------------------------

ALTER TABLE app.materials
  ADD COLUMN source_kind text NOT NULL DEFAULT 'class',
  ADD COLUMN owner_student_id uuid,
  ADD COLUMN assignment_id uuid,
  ADD COLUMN source_fingerprint text;

ALTER TABLE app.materials ALTER COLUMN class_id DROP NOT NULL;
ALTER TABLE app.materials ALTER COLUMN storage_key DROP NOT NULL;

ALTER TABLE app.materials
  ADD CONSTRAINT ck_materials_source_kind
    CHECK (source_kind IN ('class', 'personal', 'assignment')),
  ADD CONSTRAINT ck_materials_source_shape CHECK (
    (source_kind = 'class'
      AND class_id IS NOT NULL AND owner_student_id IS NULL AND assignment_id IS NULL
      AND storage_key IS NOT NULL)
    OR (source_kind = 'personal'
      AND class_id IS NULL AND owner_student_id IS NOT NULL AND assignment_id IS NULL
      AND storage_key IS NOT NULL)
    OR (source_kind = 'assignment'
      AND class_id IS NOT NULL AND owner_student_id IS NULL AND assignment_id IS NOT NULL
      AND storage_key IS NULL)
  ),
  ADD CONSTRAINT ck_materials_source_fingerprint
    CHECK (source_fingerprint IS NULL OR source_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT fk_materials_owner_student FOREIGN KEY (owner_student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- CASCADE like app.assignment_attachments: the source is derived from the assignment and has no
  -- meaning without it. Its chunks (and what was grounded on them) cascade in turn.
  ADD CONSTRAINT fk_materials_assignment FOREIGN KEY (assignment_id, school_id)
    REFERENCES app.assignments (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE;

-- One source per assignment; also the index the assignment FK's cascade looks up by.
CREATE UNIQUE INDEX uq_materials_school_assignment ON app.materials (school_id, assignment_id);

-- A student's own sources, newest first (the "My files & photos" list and its per-student cap).
CREATE INDEX idx_materials_school_owner_student_created_at
  ON app.materials (school_id, owner_student_id, created_at)
  WHERE owner_student_id IS NOT NULL;

COMMENT ON COLUMN app.materials.source_kind IS
  'class = a class''s study material; personal = a student''s own AI source (owner only); '
  'assignment = the AI source built from an assignment (000232).';
COMMENT ON COLUMN app.materials.owner_student_id IS
  'The student who owns a personal AI source; visible to that student only (000232).';
COMMENT ON COLUMN app.materials.assignment_id IS
  'The assignment an assignment AI source is built from (000232).';
COMMENT ON COLUMN app.materials.source_fingerprint IS
  'sha256 of what an assignment AI source was built from; a change re-ingests it (000232).';

-- 2. Row scope ----------------------------------------------------------------------------------------

-- 000176: admin OR class_id IN readable_class_ids(). A personal source has no class: it is its
-- owner's alone, admin included.
ALTER POLICY role_scope_visibility ON app.materials
  USING (
    (owner_student_id IS NULL
      AND ((SELECT app.current_user_is_school_admin())
           OR class_id IN (SELECT app.readable_class_ids())))
    OR (owner_student_id IS NOT NULL
      AND owner_student_id = (SELECT app.user_student_id(app.scope_user_id())))
  );

ALTER TABLE app.material_chunks ADD COLUMN owner_student_id uuid;

COMMENT ON COLUMN app.material_chunks.owner_student_id IS
  'Copied from the material by trg_material_chunks_owner: set for a personal AI source''s chunks, '
  'which only that student can read (000232).';

-- SECURITY DEFINER so the stamp never depends on what the writer can see: the material is read as
-- its owner role, still under the FORCEd tenant isolation of the caller's app.school_id.
CREATE OR REPLACE FUNCTION app.stamp_material_chunk_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  SELECT m.owner_student_id INTO NEW.owner_student_id
  FROM app.materials AS m
  WHERE m.id = NEW.material_id AND m.school_id = NEW.school_id;
  RETURN NEW;
END
$function$;

ALTER FUNCTION app.stamp_material_chunk_owner() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.stamp_material_chunk_owner() FROM PUBLIC, studafy_app;

CREATE TRIGGER trg_material_chunks_owner
BEFORE INSERT OR UPDATE OF material_id, owner_student_id ON app.material_chunks
FOR EACH ROW
EXECUTE FUNCTION app.stamp_material_chunk_owner();

CREATE POLICY personal_source_owner ON app.material_chunks
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (
    owner_student_id IS NULL
    OR owner_student_id = (SELECT app.user_student_id(app.scope_user_id()))
  );

-- 3. Only class materials are announced to a class ---------------------------------------------------

DROP TRIGGER IF EXISTS trg_materials_published ON app.materials;

CREATE TRIGGER trg_materials_published
BEFORE UPDATE OF ingest_status ON app.materials
FOR EACH ROW
WHEN (
  NEW.ingest_status = 'ready'::app.material_ingest_status
  AND OLD.ingest_status IS DISTINCT FROM 'ready'::app.material_ingest_status
  AND NEW.published_at IS NULL
  AND NEW.source_kind = 'class'
)
EXECUTE FUNCTION app.publish_material();

RESET ROLE;
