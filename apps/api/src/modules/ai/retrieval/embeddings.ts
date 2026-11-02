/**
 * Query-side embedding for hybrid retrieval (ST-162).
 *
 * The repository declares no embedding provider (the AI ingestion pipeline's swap point is the
 * worker's {@link EmbeddingStage}), so the API's query embedder is the same honest deterministic
 * mock the ingestion worker uses: a content-hash-seeded sine vector under the same model id
 * (`mock-embedding-3-small@1`) that the seed corpus and the ingestion worker write, so a query
 * vector lives in the same 1536-dimensional space as the corpus and cosine distance is defined
 * between them.
 *
 * A real provider is a one-function swap: {@link QueryEmbedder} is the whole contract the route
 * depends on, and `createDeterministicQueryEmbedder()` is the single construction site in `app.ts`.
 */

export const RETRIEVAL_EMBEDDING_MODEL = "mock-embedding-3-small@1";

export const RETRIEVAL_EMBEDDING_DIMENSIONS = 1536;

/** The chunker's four-characters-per-token rule, so query cost is metered the same way chunks are. */
export const QUERY_CHARS_PER_TOKEN = 4;

/**
 * The token cost of embedding one query text, by the same four-char rule the ingestion chunker
 * bills its batches with (`apps/workers/src/queues/ai-ingestion/chunker.ts`).
 */
export function estimateQueryTokens(text: string): number {
  return Math.ceil(text.length / QUERY_CHARS_PER_TOKEN);
}

/**
 * A non-cryptographic string hash, seeded by the content so the vector is stable across runs and
 * identical for identical text. FNV-1a, matching the ingestion worker's `mockEmbedding` derivation.
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
 * A deterministic, unit-scale pseudo-embedding for one query, formatted as a pgvector text literal.
 *
 * Byte-identical in shape to the ingestion worker's `mockEmbedding` and the seed corpus'
 * `deterministicEmbedding` (`db/seeds/support.ts`): exactly 1536 finite floats, stable across runs,
 * distinct per text so no two queries collapse to one point in the ANN graph.
 */
export function deterministicQueryEmbedding(text: string): string {
  const seed = contentSeed(text);
  const parts: string[] = [];
  for (let index = 0; index < RETRIEVAL_EMBEDDING_DIMENSIONS; index += 1) {
    parts.push(Math.sin(seed * 0.017 + index * 0.013).toFixed(6));
  }
  return `[${parts.join(",")}]`;
}

/**
 * The contract the retrieval route embeds through. A real provider (OpenAI text-embedding-3-small,
 * say) implements the same shape; the model id it reports must match the corpus' `embedding_model`
 * or the re-embed procedure in `docs/rag/hybrid-search-and-rag-storage.md` applies first.
 */
export interface QueryEmbedder {
  /** The model id every vector from this embedder was produced by. */
  readonly model: string;
  /** Embed one query text into a pgvector literal. */
  embed(text: string): string;
}

/** The repository's default embedder: the deterministic mock under `RETRIEVAL_EMBEDDING_MODEL`. */
export function createDeterministicQueryEmbedder(): QueryEmbedder {
  return {
    model: RETRIEVAL_EMBEDDING_MODEL,
    embed: deterministicQueryEmbedding,
  };
}
