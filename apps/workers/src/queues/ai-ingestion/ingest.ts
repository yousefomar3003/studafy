import { chunkBlocks } from "./chunker";
import { EMBEDDING_MODEL, mockEmbedding } from "./embedding";
import { parseDocument } from "./parsers";

import type { MaterialChunk } from "./types";

/**
 * A `MaterialChunk` plus the embedding columns it will be stored with.
 *
 * `embedding` is a pgvector text literal and `embeddingModel` names the model that produced it —
 * both are written verbatim to `app.material_chunks`.
 */
export interface IngestChunk extends MaterialChunk {
  embedding: string;
  embeddingModel: string;
}

/**
 * The pure half of ingestion: document bytes and a MIME type in, chunk rows out.
 *
 * Kept free of I/O so the pipeline (parse → chunk → embed) is testable against fixture files with
 * no database and no S3 in sight. The worker wraps this with the material claim, S3 fetch and the
 * material_chunks insert.
 */
export async function buildIngestChunks(
  bytes: Uint8Array,
  mimeType: string,
): Promise<IngestChunk[]> {
  const parsed = await parseDocument(bytes, mimeType);
  return chunkBlocks(parsed.blocks).map((chunk) => ({
    ...chunk,
    embedding: mockEmbedding(chunk.content),
    embeddingModel: EMBEDDING_MODEL,
  }));
}
