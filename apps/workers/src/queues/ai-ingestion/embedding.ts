import { TokenBucket } from "../notifications/email/rate-limiter";

import { estimateTokens } from "./chunker";

import type { MaterialChunk } from "./types";
import type { Now } from "../notifications/email/rate-limiter";

/**
 * The embedding stage of AI ingestion: turn chunked text into pgvector literals, batched,
 * rate-limit-aware, retried, and metered per tenant.
 *
 * The repository declares no embedding provider (no OpenAI/Voyage/Cohere client, no API key in
 * `apps/workers/src/env.ts`), so the provider wired in is an honest mock that derives a
 * deterministic vector from the content — the same shape the seed corpus uses — under a versioned
 * model id. The stage itself is provider-agnostic: {@link EmbeddingStage} batches, paces and
 * retries any {@link EmbeddingProvider}, so the swap point for a real client is one factory call
 * in `worker.ts`, not a rewrite of the pipeline.
 *
 * Model versioning: `EMBEDDING_MODEL` carries a `@<n>` version, so a model change is a new value
 * rather than an overwrite, and the regeneration procedure in
 * `docs/rag/hybrid-search-and-rag-storage.md` ("re-embed `WHERE embedding_model <> '<new>'`") has a
 * concrete value to diff against. The seed corpus (`db/seeds/data/materials.ts`) uses the same
 * value, so one table never mixes models — the property `ck_material_chunks_embedding_model` and
 * the design note both insist on.
 */

export const EMBEDDING_MODEL = "mock-embedding-3-small@1";

export const EMBEDDING_DIMENSIONS = 1536;

/** At most this many chunks in one provider call. */
export const DEFAULT_MAX_BATCH_CHUNKS = 16;
/** At most this many input tokens in one provider call, by the chunker's 4-char token rule. */
export const DEFAULT_MAX_BATCH_TOKENS = 4096;
/** Retries after the first failed attempt, on provider rate limits. */
export const DEFAULT_MAX_RETRIES = 3;
/** First backoff, doubled per retry. */
export const DEFAULT_BACKOFF_MS = 250;
/** The backoff never grows past this. */
export const DEFAULT_MAX_BACKOFF_MS = 8000;
/** Provider calls per second; `0` disables pacing (the mock provider needs none). */
export const DEFAULT_REQUESTS_PER_SECOND = 0;

/**
 * A provider that turns one batch of texts into one batch of pgvector literals.
 *
 * This is the contract a real embedding client implements. `embed` must return exactly one vector
 * per input text, in the same order; the stage treats any deviation as a bug and fails the job
 * rather than silently misaligning chunks with vectors. A provider signals a rate limit by
 * throwing {@link EmbeddingRateLimitError}; anything else propagates immediately.
 */
export interface EmbeddingProvider {
  /** The model id every vector from this provider was produced by. */
  readonly model: string;
  embed(texts: readonly string[]): Promise<readonly string[]>;
}

/**
 * A provider refusing work — HTTP 429. The stage alone understands it: it is retried with
 * exponential backoff and full jitter, so concurrent jobs in one process spread their retries.
 * Every other error class is thrown through, because retrying e.g. a malformed request is how a
 * job spins for its whole attempt budget on a mistake that will never resolve.
 */
export class EmbeddingRateLimitError extends Error {
  constructor(message = "embedding provider rate limit exceeded") {
    super(message);
    this.name = "EmbeddingRateLimitError";
  }
}

/**
 * Per-tenant ledger for embedding cost, one `record` per completed batch. The durable sink today is
 * `app.materials.embedding_token_cost`, written by the worker from the stage's returned total; this
 * port exists so a live provider can meter into a shared ledger (a Redis counter, an
 * `ai_usage_meters`-style table) without the stage caring where tokens land.
 */
export interface CostMeter {
  record(schoolId: string, tokens: number): void;
}

/** The default meter: the stage still counts tokens, nobody records them. */
export const nullCostMeter: CostMeter = {
  record: () => undefined,
};

/** A `MaterialChunk` plus the embedding columns it is stored with. */
export interface EmbeddedChunk extends MaterialChunk {
  embedding: string;
  embeddingModel: string;
}

export interface EmbeddingStageOptions {
  /** Max chunks per provider call (default `DEFAULT_MAX_BATCH_CHUNKS`). */
  maxBatchChunks?: number;
  /** Max input tokens per provider call, by the 4-char token rule (default `DEFAULT_MAX_BATCH_TOKENS`). */
  maxBatchTokens?: number;
  /** Provider calls per second; `0` (default) disables pacing. */
  requestsPerSecond?: number;
  /** Retries on rate limit after the first attempt (default `DEFAULT_MAX_RETRIES`). */
  maxRetries?: number;
  /** First backoff, doubled per retry (default `DEFAULT_BACKOFF_MS`). */
  backoffMs?: number;
  /** Backoff cap (default `DEFAULT_MAX_BACKOFF_MS`). */
  maxBackoffMs?: number;
  /** Clock for the rate limiter; injectable so tests run on fake time. */
  now?: Now;
  /** Backoff timer; injectable so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EmbeddingStageContext {
  /** Tenant the tokens are charged to; passed through to the meter. */
  schoolId?: string;
  /** Receives the token count of every completed batch. Defaults to {@link nullCostMeter}. */
  meter?: CostMeter;
}

export interface EmbeddingStageResult {
  /** Every input chunk, in order, with its vector and the provider's model id. */
  chunks: EmbeddedChunk[];
  /** Total input tokens billed (sum of {@link estimateTokens} over the chunks), before any retry. */
  tokens: number;
}

export interface EmbeddingStage {
  readonly provider: EmbeddingProvider;
  embed(
    chunks: readonly MaterialChunk[],
    context?: EmbeddingStageContext,
  ): Promise<EmbeddingStageResult>;
}

/**
 * A chunk-aware embedding pipeline over one {@link EmbeddingProvider}.
 *
 * Chunks are folded into batches bounded by both chunk count and input tokens (so a provider call
 * stays within its request and token limits at once), each batch is paced through a token bucket
 * when a rate is configured, and a rate-limited batch is retried with exponential backoff plus
 * full jitter. Every completed batch is metered. Output preserves input order and index: the
 * pipeline never reorders chunks, so the material's `(school_id, material_id, chunk_index)` key is
 * preserved end to end.
 */
export function createEmbeddingStage(
  provider: EmbeddingProvider,
  options: EmbeddingStageOptions = {},
): EmbeddingStage {
  const maxBatchChunks = options.maxBatchChunks ?? DEFAULT_MAX_BATCH_CHUNKS;
  const maxBatchTokens = options.maxBatchTokens ?? DEFAULT_MAX_BATCH_TOKENS;
  const requestsPerSecond = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  // The bucket starts full, so the first batch in a burst is admitted immediately and the average
  // settles to `requestsPerSecond` — the same pacing shape the SES sender uses.
  const limiter = requestsPerSecond > 0 ? new TokenBucket(requestsPerSecond, options.now) : null;

  return {
    provider,
    async embed(chunks, context = {}) {
      const meter = context.meter ?? nullCostMeter;
      const schoolId = context.schoolId ?? "";
      const result: EmbeddedChunk[] = [];
      let totalTokens = 0;

      for (let start = 0; start < chunks.length;) {
        const { batch, batchTokens } = takeBatch(chunks, start, maxBatchChunks, maxBatchTokens);
        if (limiter) await limiter.wait();
        const vectors = await embedWithRetry(
          provider,
          batch.map((chunk) => chunk.content),
          {
            maxRetries,
            backoffMs,
            maxBackoffMs,
            sleep,
          },
        );
        if (vectors.length !== batch.length) {
          throw new Error(
            `embedding provider returned ${vectors.length} vectors for a ${batch.length}-chunk batch`,
          );
        }
        for (let index = 0; index < batch.length; index += 1) {
          const chunk = batch[index]!;
          result.push({ ...chunk, embedding: vectors[index]!, embeddingModel: provider.model });
        }
        totalTokens += batchTokens;
        meter.record(schoolId, batchTokens);
        start += batch.length;
      }

      return { chunks: result, tokens: totalTokens };
    },
  };
}

/**
 * Fold chunks into one batch starting at `start`, bounded by both the chunk cap and the token cap.
 * A chunk that alone exceeds the token cap still goes out alone, so the loop always advances.
 */
function takeBatch(
  chunks: readonly MaterialChunk[],
  start: number,
  maxChunks: number,
  maxTokens: number,
): { batch: MaterialChunk[]; batchTokens: number } {
  const batch: MaterialChunk[] = [];
  let batchTokens = 0;
  for (let index = start; index < chunks.length && batch.length < maxChunks; index += 1) {
    const chunk = chunks[index]!;
    const tokens = estimateTokens(chunk.content);
    if (batch.length > 0 && batchTokens + tokens > maxTokens) break;
    batch.push(chunk);
    batchTokens += tokens;
  }
  return { batch, batchTokens };
}

async function embedWithRetry(
  provider: EmbeddingProvider,
  texts: readonly string[],
  options: {
    maxRetries: number;
    backoffMs: number;
    maxBackoffMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<readonly string[]> {
  let attempt = 0;
  for (;;) {
    try {
      return await provider.embed(texts);
    } catch (error) {
      if (!(error instanceof EmbeddingRateLimitError) || attempt >= options.maxRetries) throw error;
      const delay = Math.min(options.backoffMs * 2 ** attempt, options.maxBackoffMs);
      await options.sleep(fullJitter(delay));
      attempt += 1;
    }
  }
}

/** Full jitter: any delay in `[0, delay)`, so concurrent jobs do not re-hit a limiter in lockstep. */
function fullJitter(delay: number): number {
  return Math.floor(Math.random() * delay);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A non-cryptographic string hash, seeded by the content so the vector is stable across runs and
 * identical for identical content. FNV-1a: three lines, no allocation to speak of, and no
 * dependence on the engine's `String.prototype.hashCode` (which does not exist).
 */
function contentSeed(content: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic, unit-scale pseudo-embedding, formatted as a pgvector text literal.
 *
 * Same shape as the seed corpus' `deterministicEmbedding` in `db/seeds/support.ts`: exactly 1536
 * finite floats (the `vector(1536)` type), stable across runs, and distinct per chunk so cosine
 * distances are not all identical. The seed is a content hash rather than the chunk index, so
 * re-chunking a document produces stable embeddings for unchanged content.
 */
export function mockEmbedding(content: string): string {
  const seed = contentSeed(content);
  const parts: string[] = [];
  for (let index = 0; index < EMBEDDING_DIMENSIONS; index += 1) {
    parts.push(Math.sin(seed * 0.017 + index * 0.013).toFixed(6));
  }
  return `[${parts.join(",")}]`;
}

/**
 * The repository's default provider: the deterministic mock under `EMBEDDING_MODEL`.
 *
 * It never throws, never rate-limits, and never waits — a real provider is swapped in where this
 * is constructed (the worker), and the stage's batching, pacing, retry and metering behaviour is
 * identical either way.
 */
export function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    model: EMBEDDING_MODEL,
    async embed(texts) {
      return texts.map((text) => mockEmbedding(text));
    },
  };
}
