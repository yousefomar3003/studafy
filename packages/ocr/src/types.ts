/**
 * The contract between the AI-ingestion parsers and whatever OCR engine backs them.
 *
 * The engine is a seam, not a vendored thing: `TesseractOcrEngine` is the only implementation today
 * (see ./tesseract.ts), but a parser must not know that. It asks for a raster in, a
 * {@link OcrPageResult} out, and two facts — the engine's name and its low-confidence threshold —
 * that let the pipeline build a self-describing {@link OcrReport} without reaching into the engine.
 */
export interface OcrEngine {
  /** A stable identifier for the engine, recorded on every {@link OcrReport}. */
  readonly name: string;
  /**
   * The confidence (0-100, tesseract's mean per-word confidence) below which a page is flagged for
   * the teacher. A property of the engine's configuration, surfaced so report consumers do not have
   * to know it twice.
   */
  readonly lowConfidenceThreshold: number;
  /**
   * Recognize the text in one raster image and return the page-level result.
   *
   * `page` is the 1-based page number the image represents within its source document; the engine
   * stamps it on the result so the pipeline can map OCR output back onto the page it came from.
   */
  recognize(imageBytes: Uint8Array, page: number): Promise<OcrPageResult>;
  /** Release any worker threads / WASM instances the engine holds. Idempotent. */
  close(): Promise<void>;
}

/**
 * One page's OCR outcome. The winning language pass' text is what becomes the page's blocks; the
 * other fields feed the low-confidence flagging and the per-page cost/latency metering.
 */
export interface OcrPageResult {
  /** The 1-based page number within the source document (mirrors the engine's `page` argument). */
  page: number;
  /** The recognized text, line-joined and trimmed. */
  text: string;
  /** Mean per-word confidence (0-100) of the winning language pass. */
  confidence: number;
  /** The language (or language combination) whose pass produced `text`. */
  language: string;
  /** Wall-clock time of the OCR work for this page, in ms. */
  latencyMs: number;
  /** Number of recognized words — a low word count can explain a low confidence. */
  wordCount: number;
}

/**
 * What the pipeline records when OCR produced a document's text: which engine, at what flagging
 * threshold, and one result per OCR'd page. `null` means OCR did not run (a text-extractable PDF,
 * DOCX, or PPTX), so consumers can tell "no OCR" apart from "OCR ran cleanly".
 */
export interface OcrReport {
  engine: string;
  /** The engine's `lowConfidenceThreshold` at the time of recognition, so the report is self-describing. */
  lowConfidenceThreshold: number;
  pages: OcrPageResult[];
}
