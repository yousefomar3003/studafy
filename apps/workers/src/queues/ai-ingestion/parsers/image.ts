import type { OcrEngine, OcrReport } from "../ocr";
import type { ParsedDocument } from "../types";

/**
 * MIME types of rasters the ingestion pipeline turns into text with OCR. The set is deliberately
 * the formats tesseract's bundled leptonica decodes reliably (PNG, JPEG, BMP, TIFF); formats like
 * WebP or animated GIF are not promised until they are verified against the engine.
 */
export const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/bmp", "image/tiff"]);

export interface ParseImageOptions {
  /** The engine that turns the raster into text; the parser is pure plumbing around it. */
  ocr: OcrEngine;
}

/**
 * Parse a raster image into blocks by OCR-ing it. An image is a single "page" (the only pagination
 * a raster has), and its recognized text becomes one body block — the chunker owns splitting long
 * text. The page-level {@link OcrReport} rides along so low-confidence pages can be flagged without
 * the worker reaching into the engine.
 */
export async function parseImage(
  bytes: Uint8Array,
  options: ParseImageOptions,
): Promise<ParsedDocument> {
  const page = await options.ocr.recognize(bytes, 1);
  const ocrReport: OcrReport = {
    engine: options.ocr.name,
    lowConfidenceThreshold: options.ocr.lowConfidenceThreshold,
    pages: [page],
  };
  return {
    format: "image",
    pages: 1,
    blocks:
      page.text === "" ? [] : [{ text: page.text, kind: "body", pageNumber: 1, slideNumber: null }],
    ocrReport,
  };
}
