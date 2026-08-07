# Embedding operations

Operator notes for the embedding stage of the `ai-ingestion` queue
(`apps/workers/src/queues/ai-ingestion/embedding.ts`). What the stage does, how to tune it, and how
to move from the repository's mock provider to a real embedding model.

## What the stage does

`createEmbeddingStage(provider)` wraps any `EmbeddingProvider` (a client that turns a batch of
texts into a batch of pgvector literals) with the behaviour a production embedding call needs:

- **Batching** — chunks are folded into provider calls bounded by `maxBatchChunks` and
  `maxBatchTokens`, so a call respects a real provider's per-request and per-token limits at once.
  Output preserves chunk order and index, so the material's `(school_id, material_id, chunk_index)`
  key is never scrambled by batching.
- **Rate limiting** — with `requestsPerSecond > 0`, calls are paced through the same in-process
  token bucket the SES sender uses. One bucket per stage (per worker process), which matches the
  deployment shape: the AI-ingestion queue runs concurrency 2 in one process, so a process-local
  bucket is the honest model of the provider's per-account ceiling.
- **Retries** — `EmbeddingRateLimitError` (HTTP 429) is retried with exponential backoff
  (`backoffMs` doubled per retry, capped at `maxBackoffMs`) plus **full jitter**, so two retrying
  jobs do not re-hit a limiter in lockstep. Any other error propagates immediately.
- **Cost metering** — every completed batch's token count is metered per tenant. The worker sums
  the stage's `tokens` result and writes it to `app.materials.embedding_token_cost` in the same
  transaction that marks the material `ready`, so a material's recorded cost always matches the
  chunks that were actually stored.

The worker constructs the stage once per job with the repository's default (mock) provider:
`createEmbeddingStage(createMockEmbeddingProvider())` in `worker.ts`. That is the single swap point
for a real provider.

## Tuning knobs

`createEmbeddingStage` accepts (all optional):

| Option              | Default | Meaning                                                 |
| ------------------- | ------- | ------------------------------------------------------- |
| `maxBatchChunks`    | 16      | Max chunks per provider call.                           |
| `maxBatchTokens`    | 4096    | Max input tokens per provider call (4-char token rule). |
| `requestsPerSecond` | 0       | Provider calls per second; 0 disables pacing.           |
| `maxRetries`        | 3       | Rate-limit retries after the first attempt.             |
| `backoffMs`         | 250     | First backoff, doubled per retry.                       |
| `maxBackoffMs`      | 8000    | Backoff cap.                                            |

The defaults suit a provider in the `text-embedding-3-small` class. A cheaper/lower-rate provider
just needs a smaller `requestsPerSecond`; a provider with a tighter token window needs a smaller
`maxBatchTokens`. Tokens are the chunker's approximation (4 chars per token) — the repository has
no tokenizer, so keep `maxBatchTokens` a comfortable margin under the provider's real limit.

## Moving to a real provider

1. Add the provider client (dependency + API key env var in `apps/workers/src/env.ts`) and an
   `EmbeddingProvider` implementation whose `embed()` returns one pgvector literal per input text,
   in order, and throws `EmbeddingRateLimitError` on 429.
2. Replace the factory call in `worker.ts`. Nothing else changes: batching, pacing, retries,
   metering, and the `app.material_chunks` insert all sit behind the same stage interface.
3. Ship the new model under a **new `embedding_model` value** (the current id is
   `mock-embedding-3-small@1`). Never overwrite the id in place — cosine distance between vectors
   from two different models is a well-formed number and a meaningless one, and a per-row model id
   is what makes a partial or failed re-embed detectable.
4. Re-embed existing rows in batches, updating `embedding` and `embedding_model` together, then
   rebuild the HNSW index once at the end. The full procedure is in
   `docs/rag/hybrid-search-and-rag-storage.md` ("Embedding regeneration").

## Observability

Each material records its own total embedding cost in `app.materials.embedding_token_cost`. A
school's embedding spend over any window is a `SUM(embedding_token_cost)` over its materials —
ingestion has no student or subscription context, so the per-student `app.ai_usage_meters` ledger
cannot hold this charge.
