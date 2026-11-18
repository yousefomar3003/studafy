-- studafy:migration statement_timeout=30min
-- QA-051: Ask AI's keyword search understands Arabic.
--
-- app.material_chunks.content_tsv was to_tsvector('english', content): Arabic words were kept as
-- raw tokens, so a query only matched the exact surface form ("الشمس" but not "شمس"), and most
-- Arabic questions found nothing. The column is now the English and the Arabic (Snowball) parses
-- together; the search ORs the two query parses (modules/ai/retrieval/search.ts), so English keeps
-- its stemming and Arabic gets its own.
--
-- A generated column's expression cannot be altered in place before PostgreSQL 17, so the column
-- and its GIN index are recreated. That rewrites the table: the 30-minute statement timeout covers
-- a large school's chunks; the default lock timeout still applies.

SET ROLE studafy_admin;

DROP INDEX IF EXISTS app.idx_material_chunks_content_tsv;
ALTER TABLE app.material_chunks DROP COLUMN content_tsv;
ALTER TABLE app.material_chunks
  ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, content) || to_tsvector('arabic'::regconfig, content)
  ) STORED;
CREATE INDEX idx_material_chunks_content_tsv
  ON app.material_chunks USING gin (content_tsv);

RESET ROLE;
