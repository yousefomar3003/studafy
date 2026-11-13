# ADR-020: Lexical-only retrieval in production until a real embedding provider is wired

## Status

Accepted

## Context

Finding F-06 (`docs/security/findings-register.md`, QA-15) says production RAG uses a hash-based
pseudo-embedder for both ingestion and query. ADR-011 put embeddings in PostgreSQL and fused a
pgvector ANN leg with full-text search through Reciprocal Rank Fusion (RRF). The repository never
declared an embedding provider, so both ends of the vector leg are the same deterministic mock:

- Ingestion: `createMockEmbeddingProvider()` in `apps/workers/src/queues/ai-ingestion/embedding.ts`,
  constructed in `worker.ts`, writes `embedding_model = 'mock-embedding-3-small@1'`.
- Query: `createDeterministicQueryEmbedder()` in `apps/api/src/modules/ai/retrieval/embeddings.ts`,
  constructed in `apps/api/src/app.ts` for both `/search` and `/ask`.

The mock seeds a sine vector from an FNV-1a hash of the text. Cosine distance between two of these
vectors is well-formed and meaningless. With `AI_LLM_ENABLED=true` in `infra/fly/api.toml`,
the semantic leg added noise to every fused ranking. It also did worse than that.

**The Ask AI grounding gate depended on that noise.** `assessGrounding` (`ask/refusal.ts`) needs the
best hit's RRF score to reach `AI_ASK_MIN_RELEVANCE_SCORE = 0.02` and the hit to match the keyword
leg. One leg alone scores at most `1/(60+1) ≈ 0.0164`, so passing the gate also needed the mock to
put the same chunk near the top of its ANN results. For a school with more than 50 chunks
(`HYBRID_LEG_LIMIT`), whether a question was answered or refused partly depended on a content hash.

## Decision

1. **Production retrieval is lexical-only.** `apps/api/src/app.ts` constructs no query embedder
   (`aiQueryEmbedder = null`). Both retrieval surfaces, `POST /api/ai/students/{id}/search` and
   `/ask`, run the PostgreSQL full-text keyword leg alone.
2. **`hybridSearch` gains a lexical mode** (`apps/api/src/modules/ai/retrieval/search.ts`). Passing
   `queryVector: null` skips the HNSW settings, the semantic-leg probe and the ANN scan. The semantic
   CTE is empty and the fusion SQL is unchanged, so `semanticRank` is `null` and `rrfScore` is
   `1/(60 + keyword_rank)`. The result reports `mode: "lexical" | "hybrid"`, and `/search` exposes it
   as `meta.retrieval_mode`, an additive field.
3. **The grounding gate is mode-aware.** In lexical mode `assessGrounding(hits, "lexical")` drops the
   RRF floor, which one leg cannot reach. The verdict becomes "the best hit matched
   `websearch_to_tsquery`", which means the chunk contains every content word of the question.
   Hybrid mode keeps the old gate unchanged.
4. **Ingestion is unchanged.** The worker still writes mock vectors, because `embedding` is `NOT NULL`
   and `ck_material_chunks_embedding_model` stays satisfied. Nothing reads them. They stay labeled
   `mock-embedding-3-small@1`, so the re-embed procedure below can select them.
5. **There is no switch to turn vectors back on.** No env var or feature flag brings the mock back.
   The only embedder in the repository is the mock, so such a switch would only reintroduce F-06.
   To re-enable the semantic leg, follow **Re-enabling vector search**.

### Re-enabling vector search

A new ADR that supersedes this one, covering:

1. A real provider for both ingestion (`EmbeddingProvider`) and query (`QueryEmbedder`) under **one**
   versioned model id. The provider must be added to the subprocessor list and covered by the AI
   data-sharing consent copy (ST-305), and its secrets must be added to
   `docs/runbooks/production-secrets.md`.
2. Either the model's dimension matches `vector(1536)` (OpenAI `text-embedding-3-small` does), or a
   migration changes the column and rebuilds the HNSW index.
3. The re-embed procedure in `docs/rag/hybrid-search-and-rag-storage.md` § "Embedding regeneration"
   is run in production (`WHERE embedding_model <> '<new model>'`). Then
   `SELECT DISTINCT embedding_model FROM app.material_chunks` returns exactly the new id before the
   query embedder is wired in `app.ts`.
4. `apps/api/tests/ai-eval/retrieval.integration.test.ts` gets a real-provider configuration that
   meets the NFR-11 targets. The hybrid grounding floor gets re-tuned for real scores.

## Measured result (QA-15)

`apps/api/tests/ai-eval/retrieval.integration.test.ts` is new. It seeds all 15 golden-set cases into
one live tenant corpus and runs each query through the production `hybridSearch` and
`assessGrounding`. Run on 2026-11-03, k = 6:

| Configuration                 | Refusal correctness | Recall@6 | Groundedness (answered) | Answered |
| ----------------------------- | ------------------- | -------- | ----------------------- | -------- |
| mock-hybrid (before this ADR) | 0.600               | 0.409    | 0.750                   | 6/11     |
| **lexical (this ADR)**        | **0.600**           | 0.318    | **0.750**               | 6/11     |
| NFR-11 target                 | ≥ 0.95              | —        | ≥ 0.95                  | —        |

The two configurations make the same answer-or-refuse decision on 14 of 15 cases. The mock's recall
edge came from two chunks it happened to rank, and neither changed a verdict. **Neither
configuration meets NFR-11 on live retrieval.** The shortfall comes from the keyword leg:
`websearch_to_tsquery` ANDs every word, so "How does electrolysis work?" needs "work" in the chunk,
and "What happens during mitosis?" needs "happen". Details and per-case rows are in
`docs/security/NFR-11_rag_groundedness.md`.

## Alternatives considered

- **Wire a real provider now.** Rejected for this release. It needs a vendor choice, a new
  subprocessor and consent-copy change, production secrets, possibly a dimension migration, and a
  production re-embed run. None of that can be done or verified in a code change, and it would hold
  up the release blocker.
- **Keep the mock and lower `AI_ASK_MIN_RELEVANCE_SCORE`.** Rejected. The result would still depend
  on a content hash.
- **An env flag defaulting to off in production.** Rejected. The only thing it could turn on is the
  mock, so it would be a switch for F-06 itself.
- **Drop the `embedding` column or the HNSW index.** Deferred. Keeping them makes re-enabling a data
  backfill, not a schema change. The cost is HNSW write amplification on ingest for an index nothing
  reads.

## Consequences

- F-06 is closed. Production retrieval no longer uses meaningless vectors, and the Ask AI verdict no
  longer depends on a hash.
- **Ask AI on live retrieval is below the NFR-11 targets.** Shipping it is a product call. The
  alternative under release exit criterion 2 (`docs/testing/qa-plan.md` §5) is to disable the AI
  features in production. The fix that follows from the measurements is to change the keyword leg so
  that not every question word must match (an OR query ranked by `ts_rank_cd`), plus a gate on how
  much of the question the best chunk covers. That needs its own ticket and its own eval run. CI
  holds the measured floor in the meantime, so retrieval cannot get worse without notice.
- The web and mobile apps contain no copy that claims "semantic" search (checked 2026-11-03). The
  `/search` OpenAPI description now says production is lexical-only. Marketing pages outside this
  repository were not checked.
- `/search` still commits `estimateQueryTokens(query)` against the student's AI quota, although no
  embedding call happens. The meter is a product quota, not a provider bill, so it is left as is.
- The mock embedders stay for tests and the hybrid code path. `embeddings.ts` and `app.ts` both say
  the mock must not be wired in production.

## Review

Accepted on 2026-11-03 by the project owner, who chose lexical-only retrieval for production in the
QA-15 session along with a DB-backed golden-set eval.
