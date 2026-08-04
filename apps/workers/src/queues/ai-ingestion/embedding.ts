/**
 * The embedding used by AI ingestion.
 *
 * This is the PLACEHOLDER embedding, not a production one. The repository declares no embedding
 * client anywhere (no OpenAI/Voyage/Cohere dependency, no API key in apps/workers/src/env.ts), and
 * `app.material_chunks.embedding` is `vector(1536) NOT NULL` — so the row cannot exist without a
 * vector. Rather than ship a fake client that pretends to call a model, ingestion stores a
 * deterministic, content-derived vector under the same model name the seed corpus and benchmarks
 * already use (`mock-embedding-3-small`), which keeps every row in the table on one consistent
 * embedding model — the property `ck_material_chunks_embedding_model` and
 * `docs/rag/hybrid-search-and-rag-storage.md` both insist on.
 *
 * The moment a real embedding provider exists, this module is the single place to swap it out: the
 * per-row `embedding_model` makes the migration detectable, and content is retained verbatim on the
 * chunk, so every embedding can be regenerated from it. See the regeneration procedure in
 * docs/rag/hybrid-search-and-rag-storage.md.
 */
export const EMBEDDING_MODEL = "mock-embedding-3-small";

export const EMBEDDING_DIMENSIONS = 1536;

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
