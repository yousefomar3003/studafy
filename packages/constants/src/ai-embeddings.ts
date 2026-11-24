/**
 * Retrieval embeddings shared by the API (query side) and the ingestion worker (chunk side).
 *
 * Both sides must label their vectors with the same id, because the semantic search leg only
 * compares a question with chunks embedded by the same model: cosine distance between vectors from
 * two models is a well-formed number and a meaningless one (ADR-021). The dimension is the
 * `vector(1536)` column of `app.material_chunks`; the provider is asked for exactly that many.
 */

/** The dimension of `app.material_chunks.embedding` and of every vector requested from a provider. */
export const AI_EMBEDDING_DIMENSIONS = 1536;

/**
 * The `embedding_model` value stored with a vector from `model` (a provider model id such as
 * `google/gemini-embedding-001`): the model plus the dimension it was requested at, so the same
 * model at another size is a different value and a re-embed can select it.
 */
export function aiEmbeddingModelId(model: string): string {
  return `${model}@${AI_EMBEDDING_DIMENSIONS}`;
}
