import { AI_EMBEDDING_DIMENSIONS, aiEmbeddingModelId } from "@studafy/constants";

import { routingPrivacy } from "../llm/openai-compatible";

/**
 * Query-side embedding for hybrid retrieval (ST-162, ADR-024).
 *
 * Production embeds the question through an OpenAI-compatible `/embeddings` endpoint (OpenRouter,
 * {@link createOpenAiCompatibleQueryEmbedder}) with the same model the ingestion worker embeds
 * chunks with, labeled by `aiEmbeddingModelId` on both sides. `app.ts` receives the embedder from
 * `index.ts`, which builds it only when `AI_EMBEDDING_MODEL` is set; without one, retrieval is
 * lexical-only (ADR-020).
 *
 * The deterministic mock below stays for tests and local hybrid-path coverage only: its vectors are
 * a content hash, so cosine distance between them carries no meaning, and it must never be wired in
 * production. It lives in the same 1536-dimensional space as the mock the seed corpus and the
 * ingestion worker's fallback write (`mock-embedding-3-small@1`).
 */

export const RETRIEVAL_EMBEDDING_MODEL = "mock-embedding-3-small@1";

export const RETRIEVAL_EMBEDDING_DIMENSIONS = AI_EMBEDDING_DIMENSIONS;

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
 * The contract the retrieval routes embed through. `model` must be the `embedding_model` value the
 * ingestion worker writes for the same provider model; the semantic leg compares the question with
 * those chunks only.
 */
export interface QueryEmbedder {
  /** The `embedding_model` value of every vector from this embedder. */
  readonly model: string;
  /** Embed one query text into a pgvector literal. */
  embed(text: string): Promise<string>;
}

/** The repository's default embedder: the deterministic mock under `RETRIEVAL_EMBEDDING_MODEL`. */
export function createDeterministicQueryEmbedder(): QueryEmbedder {
  return {
    model: RETRIEVAL_EMBEDDING_MODEL,
    embed: async (text) => deterministicQueryEmbedding(text),
  };
}

/** The question embedding call's whole-request timeout; past it the route searches by keyword. */
export const QUERY_EMBEDDING_TIMEOUT_MS = 5000;

export interface OpenAiCompatibleQueryEmbedderOptions {
  apiKey: string;
  /** The API root (…/v1); `/embeddings` is appended. */
  baseUrl: string;
  /** The provider's model id, e.g. `google/gemini-embedding-001`. */
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * A query embedder over an OpenAI-compatible `/embeddings` endpoint. It asks for
 * {@link AI_EMBEDDING_DIMENSIONS} dimensions and, on OpenRouter, only for hosts that neither retain
 * nor train on the data (the same `routingPrivacy` the chat calls send). Any failure throws; the
 * routes catch it and fall back to a keyword-only search, so an embedding outage never fails a
 * question.
 */
export function createOpenAiCompatibleQueryEmbedder(
  options: OpenAiCompatibleQueryEmbedderOptions,
): QueryEmbedder {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/embeddings`;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? QUERY_EMBEDDING_TIMEOUT_MS;
  return {
    model: aiEmbeddingModelId(options.model),
    async embed(text) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          input: [text],
          dimensions: AI_EMBEDDING_DIMENSIONS,
          ...routingPrivacy(options.baseUrl),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`embedding provider answered HTTP ${response.status}`);
      }
      const [vector] = parseEmbeddingResponse(await response.json(), 1);
      return toPgVector(vector!);
    },
  };
}

/**
 * The vectors of an OpenAI-compatible embeddings response, in input order. Throws unless there is
 * exactly one finite vector of {@link AI_EMBEDDING_DIMENSIONS} numbers per input: a short or
 * misordered answer stored or compared silently would be a recall bug nobody sees.
 */
export function parseEmbeddingResponse(body: unknown, expected: number): number[][] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error(
      `embedding provider returned ${Array.isArray(data) ? data.length : 0} vectors for ${expected} inputs`,
    );
  }
  const ordered = [...data].sort(
    (a, b) =>
      Number((a as { index?: number }).index ?? 0) - Number((b as { index?: number }).index ?? 0),
  );
  return ordered.map((item) => {
    const vector = (item as { embedding?: unknown }).embedding;
    if (
      !Array.isArray(vector) ||
      vector.length !== AI_EMBEDDING_DIMENSIONS ||
      !vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new Error(
        `embedding provider returned a malformed ${AI_EMBEDDING_DIMENSIONS}-dimension vector`,
      );
    }
    return vector as number[];
  });
}

/** A vector as a pgvector text literal. */
export function toPgVector(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/** The vector fields of a `HybridSearchInput`: a question vector and its model, or none. */
export interface SearchVector {
  queryVector: string | null;
  embeddingModel?: string;
}

/**
 * Embed a search query for the semantic leg, or fall back to keyword-only search. No embedder (none
 * configured) and a failed or timed-out embedding call both yield `queryVector: null`, so the
 * provider being down degrades a search to lexical instead of failing it; `onError` reports the
 * failure. Call it before opening the tenant transaction, so the network call never holds a
 * database connection.
 */
export async function embedForSearch(
  embedder: QueryEmbedder | null,
  text: string,
  onError: (error: unknown) => void,
): Promise<SearchVector> {
  if (!embedder) return { queryVector: null };
  try {
    return { queryVector: await embedder.embed(text), embeddingModel: embedder.model };
  } catch (error) {
    onError(error);
    return { queryVector: null };
  }
}
