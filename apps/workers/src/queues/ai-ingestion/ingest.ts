import { chunkBlocks } from "./chunker";
import { createEmbeddingStage, createMockEmbeddingProvider, nullCostMeter } from "./embedding";
import { parseDocument, type ParseDocumentOptions } from "./parsers";

import type { CostMeter, EmbeddingStage } from "./embedding";
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

export interface IngestOptions extends ParseDocumentOptions {
  /**
   * The embedding stage that turns chunks into vectors. Defaults to a stage over the repository's
   * mock provider, so the pure pipeline (and its tests) need no wiring.
   */
  embedder?: EmbeddingStage;
  /** Tenant the embedding cost is charged to; passed through to the stage's meter. */
  schoolId?: string;
  /** Receives the token count of every completed batch. Defaults to a no-op meter. */
  meter?: CostMeter;
}

export interface BuildIngestChunksResult {
  chunks: IngestChunk[];
  /** Non-null iff OCR produced the document's text (see `ParsedDocument.ocrReport`). */
  ocrReport: OcrReport | null;
  /** Total input tokens the embedding stage billed for this document (sum of the batches). */
  embeddingTokens: number;
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
  options: IngestOptions = {},
): Promise<BuildIngestChunksResult> {
  const parsed = await parseDocument(bytes, mimeType, options);
  const embedder = options.embedder ?? defaultEmbedder;
  const embedded = await embedder.embed(chunkBlocks(parsed.blocks), {
    schoolId: options.schoolId,
    meter: options.meter ?? nullCostMeter,
  });
  return {
    chunks: embedded.chunks,
    ocrReport: parsed.ocrReport,
    embeddingTokens: embedded.tokens,
  };
}

const defaultEmbedder = createEmbeddingStage(createMockEmbeddingProvider());
