# ADR-024: Semantic retrieval with a real embedding model through OpenRouter

## Status

Accepted (2026-11-24). Supersedes [ADR-020](0020-lexical-only-retrieval.md).

## Context

ADR-020 made production retrieval keyword-only, because the only embedder in the repository was a
content-hash mock. Keyword search has two problems, and they hurt Arabic most:

- `websearch_to_tsquery` ANDs every word of the question, so any wording the material does not use
  misses. "التمثيل الضوئي" finds nothing in a book that says "البناء الضوئي", and a question in
  Jordanian dialect or in the other language finds nothing at all.
- When nothing matches, the grounding gate refuses. Students see "I couldn't find this in your
  materials" for questions the materials answer.

ADR-020 lists what re-enabling the semantic leg needs. This ADR does each item.

## Decision

1. **One model on both sides: `google/gemini-embedding-001` at 1536 dimensions, through
   OpenRouter.** Questions are embedded by the API (`createOpenAiCompatibleQueryEmbedder`) and chunks
   by the ingestion worker (`createOpenAiCompatibleEmbeddingProvider`). Both read
   `AI_EMBEDDING_MODEL` (in `infra/fly/api.toml` and `infra/fly/workers.toml`) and use the chat
   calls' host and key (`AI_LLM_BASE_URL`, `AI_LLM_API_KEY`). Both label vectors
   `aiEmbeddingModelId(model)` = `google/gemini-embedding-001@1536` (`@studafy/constants`). The model
   is asked for 1536 dimensions, so `vector(1536)` and the HNSW index stay as they are, with no
   migration. Every request carries `provider.data_collection: "deny"`, the same routing the chat
   calls use, so only hosts that neither retain nor train on the data are used.
2. **The semantic leg compares a question only with chunks of the same model.** `hybridSearch`
   takes `embeddingModel` and filters both semantic queries on `embedding_model`. A chunk still
   carrying the mock's vector is invisible to the semantic leg and still found by the keyword leg. So
   a deploy, a partial backfill or a provider outage can never mix two vector spaces in one
   comparison. This replaces ADR-020's "re-embed everything before wiring the query embedder"
   ordering with a property that holds at all times.
3. **Nothing fails because embeddings fail.**
   - Query side: `embedForSearch` falls back to a keyword-only search when the embedding call fails
     or takes more than 5 s.
   - Ingestion side: `createFallbackEmbeddingStage` stores the mock's vectors when the provider
     fails past its 429 retries, so the material is still ready and keyword-searchable.
   - The embedding call runs before the tenant transaction opens, so it never holds a database
     connection.
4. **A re-embed sweep keeps the corpus on the live model.** `reembed-stale-chunks` runs on the
   maintenance queue at :20 and :50. It re-embeds every chunk whose `embedding_model` is not the live
   one, which covers:
   - the mock vectors from before this ADR (526 chunks in production on 2026-11-24);
   - outage fallbacks;
   - a future model change.

   It works from the stored `content`, in batches of 32, at most 2000 rows a run. The update is
   guarded on the label it read. This is the "Embedding regeneration" procedure of
   `docs/rag/hybrid-search-and-rag-storage.md`, run continuously.

5. **The grounding gate trusts meaning.** `assessGrounding` answers when some hit matched the keyword
   leg, or, in hybrid mode, when some hit's cosine similarity reaches
   `AI_ASK_MIN_SEMANTIC_SIMILARITY = 0.55`. That constant replaces the mock-era
   `AI_ASK_MIN_RELEVANCE_SCORE` RRF floor. Lexical mode keeps the keyword arm only.

## Measurements

Model choice, OpenRouter, 1536 dimensions, 20 Arabic and English biology/chemistry passages with
close-topic distractors, 24 questions (most in Jordanian dialect, some cross-language), top-1 hit:

| Model                         | top-1 | Price per million tokens |
| ----------------------------- | ----- | ------------------------ |
| google/gemini-embedding-001   | 24/24 | $0.15                    |
| mongodb/voyage-4 (1024 only)  | 24/24 | $0.06                    |
| qwen/qwen3-embedding-8b       | 23/24 | $0.01                    |
| openai/text-embedding-3-large | 23/24 | $0.13                    |
| cohere/embed-5-pro            | 21/24 | $0.12                    |
| baai/bge-m3                   | 19/24 | $0.01                    |

`voyage-4` would need a dimension migration, and Google already hosts the chat model. Re-embedding
all of production costs about $0.03.

Similarity floor: see `AI_ASK_MIN_SEMANTIC_SIMILARITY` in `apps/api/src/modules/ai/config.ts` for
the score ranges it was sized on.

Golden set through live PostgreSQL (`tests/ai-eval/retrieval.integration.test.ts`, k = 6, run with
`AI_EVAL_EMBEDDING_API_KEY` and `AI_EVAL_EMBEDDING_MODEL=google/gemini-embedding-001`):

| Configuration          | Refusal correctness | Recall@6  | Groundedness (answered) | Answered  |
| ---------------------- | ------------------- | --------- | ----------------------- | --------- |
| lexical (ADR-020)      | 0.625               | 0.292     | 0.750                   | 6/12      |
| mock-hybrid            | 0.750               | 0.375     | 0.458                   | 12/12     |
| **live-hybrid (this)** | **0.875**           | **1.000** | **1.000**               | **12/12** |

Groundedness now meets NFR-11 (≥ 0.95). Refusal correctness is still below it. The two misses are
near-topic questions (volcanoes against an earthquake chunk at 0.557, the capital of France against a
chunk about Lyon at 0.567). They reach the model, which prompt rule 4 tells to say the sources do not
answer.

## Consequences

- Students' questions in other words, in dialect, or in the other language are answered from their
  materials. This is the change the Arabic-speaking audience needs most.
- Class-material text is now also sent to OpenRouter when it is ingested, not only when a student
  uses an AI feature. It goes to the same sub-processor and carries the same data categories, with
  the same no-retention routing. Only materials in classes with the AI materials setting on are
  ingested, as before. The privacy notice and the school agreement name the embedding use.
- Each question adds one embedding call, about 0.3–1 s, before retrieval. A failure degrades that
  question to keyword search.
- `/search` still meters `estimateQueryTokens(query)` against the student's quota; the provider
  cost of a query embedding is negligible ($0.15 per million tokens).
- The hybrid code path is live, so the HNSW index is read again and its write amplification on
  ingest now buys something.
- The mock embedders stay, for tests and as the ingestion fallback. The fallback's vectors are
  labeled with the mock's model id, so no reader trusts them.

## Alternatives considered

- **Re-embed first, then wire the query embedder (ADR-020's order).** Rejected. It needs a
  coordinated one-off production run, and it breaks again on any later outage or model change. The
  model filter makes the order irrelevant.
- **Keyword-leg OR query instead of embeddings** (ADR-020's suggested follow-up). It helps
  word-order and stop-word misses, but not synonyms, dialect or cross-language questions, which are
  the Arabic problem. It stays a possible complement.
- **A separate embedding vendor (OpenAI, Voyage, Cohere directly).** Rejected. OpenRouter is already
  the disclosed AI sub-processor, with the routing privacy setting already in place, so a direct
  vendor would add a sub-processor for no quality gain.
