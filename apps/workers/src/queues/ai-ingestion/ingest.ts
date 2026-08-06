import { chunkBlocks } from "./chunker";
import { EMBEDDING_MODEL, mockEmbedding } from "./embedding";
import { parseDocument, type ParseDocumentOptions } from "./parsers";

import type { OcrReport } from "./ocr";
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

export interface BuildIngestChunksResult {
  chunks: IngestChunk[];
  /** Non-null iff OCR produced the document's text (see `ParsedDocument.ocrReport`). */
  ocrReport: OcrReport | null;
}

/**
 * The pure half of ingestion: document bytes and a MIME type in, chunk rows out.
 *
 * Kept free of I/O so the pipeline (parse → chunk → embed) is testable against fixture files with
 * no database and no S3 in sight. The worker wraps this with the material claim, S3 fetch and the
 * material_chunks insert. OCR is the one non-pure part: an {@link OcrEngine} is injected by the
 * caller and closed by the caller, so this function neither spawns nor leaks worker threads.
 */
export async function buildIngestChunks(
  bytes: Uint8Array,
  mimeType: string,
  options: ParseDocumentOptions = {},
): Promise<BuildIngestChunksResult> {
  const parsed = await parseDocument(bytes, mimeType, options);
  return {
    chunks: chunkBlocks(parsed.blocks).map((chunk) => ({
      ...chunk,
      embedding: mockEmbedding(chunk.content),
      embeddingModel: EMBEDDING_MODEL,
    })),
    ocrReport: parsed.ocrReport,
  };
}
