# ADR-011: pgvector for AI retrieval — embeddings live beside their facts

## Status

Accepted

## Context

Studafy's AI features (ask-AI, quiz generation, flashcards) retrieve from `app.material_chunks` —
chunked material text, one row per contiguous slice, produced by the AI-ingestion queue. The
retrieval requirement (ST-047, documented in
[`docs/rag/hybrid-search-and-rag-storage.md`](../rag/hybrid-search-and-rag-storage.md)) is _hybrid_:
an approximate-nearest-neighbour leg over embeddings for paraphrase, and a lexical leg for exact
identifiers, proper nouns, and negation. Both legs must be tenant-isolated: a fused result must
never contain another school's chunk. The decision to record is where embeddings live and how the
vector index is shaped.

## Decision

- **Embeddings are stored in PostgreSQL via the `vector` extension — there is no separate vector
  database.** `000003` enables the `vector` extension (extension name `vector`, not `pgvector`) on
  PostgreSQL 16 alongside `pgcrypto`, `pg_trgm`, and `pg_stat_statements`. Embeddings therefore
  live in the same transaction as the chunk text they describe, which is what lets ingestion write
  text + embedding + outbox event atomically (ADR-0012).
- **One table models the corpus: `app.material_chunks` (`000019`).** Each row is one chunk: `content`
  (the normalized source text, retained in full — the embedding is derived data and never the source
  of truth), `embedding public.vector(1536)` (cosine, matching OpenAI `text-embedding-3-small` /
  `ada-002`), `embedding_model` (recorded per row so a model change is detectable and a partial
  re-embed is answerable), `chunk_index` for in-material ordering and neighbour expansion, and
  typed citation anchors (`page_number`, `section_title`). A generated `content_tsv tsvector
(IMMUTABLE to_tsvector('english', ...))` provides the lexical leg.
- **Indexing: one global HNSW graph, not per-tenant partitions.** `idx_material_chunks_embedding_hnsw
(embedding vector_cosine_ops, m=16, ef_construction=64)` is a single HNSW index across all
  tenants. This table is deliberately _not_ partitioned (unlike attendance / audit logs): declarative
  partitioning would give each partition its own HNSW graph, and a global top-k query would descend
  all of them and merge — losing recall at every boundary. Tenant scoping is achieved by RLS on the
  rows (ADR-0015), not by physical separation. A GIN index on `content_tsv` serves the lexical leg.
- **Retrieval must compensate for how HNSW + RLS interact.** An HNSW index returns the global
  nearest neighbours; the RLS predicate then filters those candidates, so `ORDER BY embedding <=>
$1 LIMIT 10` can silently return _fewer_ than 10 rows the smaller a school's share of the corpus.
  Every retrieval query therefore sets `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` (pgvector
  0.8+) so the scan keeps pulling candidates until the LIMIT is satisfied after filtering. `SET
LOCAL`, not `SET`, because the runtime sits behind PgBouncer in transaction pooling and a
  session-level GUC would leak into the next request. Integration tests assert the under-return
  failure directly.
- **Hybrid ranking is fused in SQL.** The two legs are independently RLS-filtered and combined with
  Reciprocal Rank Fusion in the retrieval query (see the design note) — the same SQL that carries
  the tenant isolation, so neither leg can leak.
- **IVFFlat is explicitly rejected as a pattern.** Its centroids are computed at build time, so an
  index built on an empty or unrepresentative table is genuinely wrong; HNSW builds incrementally and
  is created here before ingestion (see `docs/database/extensions.md`'s "never create a vector index
  on an empty table to satisfy a task").

## Alternatives considered

- **A dedicated vector database (Pinecone, Qdrant, Weaviate, Milvus)** — best-of-breed recall at
  scale, but it splits the write transaction: chunk text commits in Postgres and embeddings in a
  second system, with no atomic outbox across the two, and every tenant filter becomes a second hop.
  Rejected: the corpus is school-owned and must be tenant-isolated by the same mechanism as every
  other table, and the per-tenant recall problem we measured (HNSW-global + RLS-filter) is solved by
  `iterative_scan`, not by a second database.
- **IVFFlat with periodic rebuilds** — simpler query planner story, but built on empty tables it is
  the known-false pattern; HNSW `m=16/ef_construction=64` is the ticket's own parameters and the
  measured build cost is recorded in the design note rather than guessed.
- **External, non-SQL retrieval glued at the application layer** (index in a second store, query
  Postgres for metadata afterwards) — recreates the dual-write problem and loses per-leg RLS.

## Consequences

- One database, one transaction for text + embedding + outbox: ingestion remains atomic and the
  corpus cannot drift from the materials it indexes.
- The vector index is a global graph; recall correctness depends on every retrieval site setting the
  iterative-scan GUC in a `SET LOCAL` transaction. Forgetting it under-returns silently — the tests
  (`material-chunks` integration + RLS coverage) are what keep that from regressing.
- A future embedding-model change is a re-derivation exercise readable from `embedding_model`, not a
  data-format change; `vector(1536)` pins the dimension at the column type.

## Review

Reviewed by `baderalhindi` on 2026-09-11.
