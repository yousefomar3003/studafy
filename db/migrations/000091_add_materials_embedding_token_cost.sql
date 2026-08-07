-- Adds app.materials.embedding_token_cost: the per-material embedding cost ledger for AI ingestion
-- (ST-160).
--
-- The ai-ingestion job carries only a school and a material, never a student or an AI subscription,
-- so the per-student app.ai_usage_meters ledger (000021) cannot hold this charge. The cost of
-- embedding a material's chunks is instead recorded on the material itself: one row, one running
-- total, written by the worker in the same transaction that marks the material `ready` — so the
-- charge and the rows it paid for can never diverge, and a school's embedding spend over any window
-- is a SUM over its materials.
--
-- The unit is input tokens (the chunker's 4-char-per-token rule), the same unit the embedding stage
-- meters per batch. A new value of the embedding model does not invalidate a material's recorded
-- cost: the column is the historical ledger, while re-embedding to a new model is tracked by
-- app.material_chunks.embedding_model (see docs/rag/hybrid-search-and-rag-storage.md).

SET ROLE studafy_admin;

ALTER TABLE app.materials
  ADD COLUMN embedding_token_cost bigint NOT NULL DEFAULT 0;

ALTER TABLE app.materials
  ADD CONSTRAINT ck_materials_embedding_token_cost CHECK (embedding_token_cost >= 0);

RESET ROLE;
