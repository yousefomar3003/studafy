-- Reference mirror of the tenant isolation installed on app.material_chunks by migration 000019. This
-- file is documentation: the runner only executes db/migrations. It is kept faithful to the migration so
-- a reviewer can read the security posture of the RAG corpus without reading the whole migration.
--
-- Design note: docs/rag/hybrid-search-and-rag-storage.md
-- ERD:         docs/api/material-chunks-data-model.md

-- ---------------------------------------------------------------------------------------------------
-- 1. Grants. Ordinary CRUD for the runtime role: chunks are re-derived on re-ingestion, so unlike the
--    audit log (000018) this table is not append-only.
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.material_chunks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.material_chunks TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 2. The canonical ST-034 tenant policy.
-- ---------------------------------------------------------------------------------------------------

SELECT app.apply_tenant_isolation('app', 'material_chunks');

-- The helper enables AND forces RLS and installs exactly this policy:
--
-- CREATE POLICY tenant_isolation ON app.material_chunks
--   AS PERMISSIVE
--   FOR ALL
--   TO PUBLIC
--   USING (school_id = current_setting('app.school_id')::uuid)
--   WITH CHECK (school_id = current_setting('app.school_id')::uuid);
--
-- It covers the vector and full-text access paths for free. RLS filters the rows a query returns
-- regardless of which index produced them, so an `embedding <=> $1` ordering and a `content_tsv @@ $2`
-- match are filtered exactly like a plain SELECT. The integration tests assert isolation separately on
-- the ANN path, the FTS path, and the fused RRF hybrid, because "the policy exists" and "every retrieval
-- path is actually isolated" are different claims.

-- ---------------------------------------------------------------------------------------------------
-- 3. Tenant integrity is ALSO enforced in the schema, and that is not redundant.
-- ---------------------------------------------------------------------------------------------------

-- CONSTRAINT fk_material_chunks_material FOREIGN KEY (material_id, school_id)
--   REFERENCES app.materials (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE
--
-- The composite reference makes a chunk pointing at another school's material impossible at the schema
-- level. That guarantee holds where RLS does not run: for a superuser, for a role with BYPASSRLS, and
-- inside a SECURITY DEFINER function. RLS is a row filter, not a referential guarantee, and the two are
-- not substitutes for one another -- which is why both are present.

-- ---------------------------------------------------------------------------------------------------
-- 4. RLS does not make ANN retrieval safe by itself. READ THIS BEFORE WRITING A RETRIEVAL QUERY.
-- ---------------------------------------------------------------------------------------------------

-- An HNSW index returns the GLOBAL nearest neighbours; the tenant policy is applied as a FILTER to those
-- candidates, because the graph traversal has no idea what a school is. The rows that come back are
-- always correctly isolated -- but there may be FEWER of them than the LIMIT asked for, and no error is
-- raised. Measured on a 100,000-chunk corpus with the acting school owning 25,000 and LIMIT 50:
--
--   hnsw.iterative_scan = off (the pgvector default)  ->  15 rows returned, recall 15/50
--   hnsw.iterative_scan = relaxed_order, ef_search=100 -> 50 rows returned, recall 50/50
--
-- Every retrieval transaction must therefore issue:
--
--   SET LOCAL hnsw.iterative_scan = 'relaxed_order';
--   SET LOCAL hnsw.ef_search = 100;
--
-- SET LOCAL, not SET: the runtime is behind PgBouncer in transaction pooling mode, where a session-level
-- GUC leaks into the next request (docs/runbooks/pgbouncer-conventions.md).
--
-- And the caller must still CHECK that the semantic leg returned what it asked for. Reciprocal Rank
-- Fusion is a FULL OUTER JOIN, so a short or empty vector leg still yields a full result set carried by
-- the keyword leg: the symptom of a broken vector search is quietly worse answers, not an error.
