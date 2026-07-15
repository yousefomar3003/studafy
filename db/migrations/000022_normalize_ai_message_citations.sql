-- Replaces ai_messages.cited_chunk_ids with a normalized, ordered tenant-safe junction table.
-- Existing citation UUIDs that no longer resolve to a material chunk in the same school are omitted
-- during backfill and reported as a NOTICE. Valid duplicate citations are preserved at their original
-- one-based positions. The migration is transactional, so the new table and removed array become
-- visible atomically.

SET ROLE studafy_admin;

CREATE TABLE app.ai_message_citations (
  school_id uuid NOT NULL,
  ai_message_id uuid NOT NULL,
  material_chunk_id uuid NOT NULL,
  citation_order integer NOT NULL,

  CONSTRAINT pk_ai_message_citations
    PRIMARY KEY (school_id, ai_message_id, citation_order),
  CONSTRAINT fk_ai_message_citations_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_message_citations_message
    FOREIGN KEY (ai_message_id, school_id) REFERENCES app.ai_messages (id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_ai_message_citations_chunk
    FOREIGN KEY (material_chunk_id, school_id) REFERENCES app.material_chunks (id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_ai_message_citations_order CHECK (citation_order >= 1)
);

-- Supports chunk deletion/citation lookup without scanning every citation in a school. The primary
-- key already supplies the school/message/order path and satisfies the universal RLS predicate.
CREATE INDEX idx_ai_message_citations_school_chunk_message
  ON app.ai_message_citations (school_id, material_chunk_id, ai_message_id);

DO $backfill$
DECLARE
  tenant_id uuid;
  tenant_skipped bigint;
  skipped_count bigint := 0;
BEGIN
  -- Both source tables already FORCE RLS. Backfill one school at a time with transaction-local tenant
  -- context instead of weakening RLS during the migration.
  FOR tenant_id IN SELECT id FROM app.schools ORDER BY id LOOP
    PERFORM pg_catalog.set_config('app.school_id', tenant_id::text, true);

    SELECT count(*)
    INTO tenant_skipped
    FROM app.ai_messages AS message
    CROSS JOIN LATERAL unnest(message.cited_chunk_ids)
      WITH ORDINALITY AS citation(chunk_id, position)
    LEFT JOIN app.material_chunks AS chunk
      ON chunk.id = citation.chunk_id
     AND chunk.school_id = message.school_id
    WHERE message.school_id = tenant_id
      AND chunk.id IS NULL;

    skipped_count := skipped_count + tenant_skipped;

    INSERT INTO app.ai_message_citations (
      school_id,
      ai_message_id,
      material_chunk_id,
      citation_order
    )
    SELECT
      message.school_id,
      message.id,
      chunk.id,
      citation.position::integer
    FROM app.ai_messages AS message
    CROSS JOIN LATERAL unnest(message.cited_chunk_ids)
      WITH ORDINALITY AS citation(chunk_id, position)
    JOIN app.material_chunks AS chunk
      ON chunk.id = citation.chunk_id
     AND chunk.school_id = message.school_id
    WHERE message.school_id = tenant_id;
  END LOOP;

  IF skipped_count > 0 THEN
    RAISE NOTICE
      'omitting % stale or cross-school ai_messages.cited_chunk_ids value(s) during normalization',
      skipped_count;
  END IF;
END
$backfill$;

ALTER TABLE app.ai_messages
  DROP CONSTRAINT ck_ai_messages_cited_chunk_ids,
  DROP COLUMN cited_chunk_ids;

REVOKE ALL PRIVILEGES ON TABLE app.ai_message_citations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.ai_message_citations TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'ai_message_citations');

RESET ROLE;
