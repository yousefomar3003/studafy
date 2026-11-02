import { UnsupportedFormatError } from "../errors";

import { parseDocx } from "./docx";
import { IMAGE_MIME_TYPES, parseImage } from "./image";
import { parsePdf } from "./pdf";
import { parsePptx } from "./pptx";

import type { OcrEngine } from "../ocr";
import type { ParsedDocument } from "../types";

export { IMAGE_MIME_TYPES } from "./image";

/** MIME types the ingestion pipeline can parse, and their parsers. */
export const PDF_MIME_TYPES = new Set(["application/pdf", "application/x-pdf", "text/pdf"]);
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * Formats whose text can come from OCR: rasters always, PDFs when a page has no text layer (scans).
 * The worker creates an engine for exactly these, so text PDFs never pay for a worker thread that
 * goes unused — the engine spawns its tesseract worker lazily on first recognize, and a text PDF
 * never recognizes.
 */
export function isOcrCandidate(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType) || PDF_MIME_TYPES.has(mimeType);
}

export interface ParseDocumentOptions {
  /**
   * The OCR engine used for rasters. Required for image MIME types; a raster without an engine is
   * a configuration error, so it is rejected as loudly as an unsupported format.
   */
  ocr?: OcrEngine;
}

/**
 * Parse a document's bytes into reading-order blocks. The format is chosen by the material's stored
 * MIME type; anything else is rejected before any bytes are interpreted. No shell-outs: parsing is
 * pure in-process library work, so a hostile file can neither spawn processes nor reach the
 * filesystem. Images and textless (scanned) PDF pages are the parsers that spawn real work — the
 * OCR worker threads — and only when an engine is supplied.
 */
export async function parseDocument(
  bytes: Uint8Array,
  mimeType: string,
  options: ParseDocumentOptions = {},
): Promise<ParsedDocument> {
  if (PDF_MIME_TYPES.has(mimeType)) {
    return parsePdf(bytes, options);
  }
  if (mimeType === DOCX_MIME_TYPE) {
    return parseDocx(bytes);
  }
  if (mimeType === PPTX_MIME_TYPE) {
    return parsePptx(bytes);
  }
  if (IMAGE_MIME_TYPES.has(mimeType)) {
    if (!options.ocr) {
      throw new UnsupportedFormatError(`ocr engine not configured for mime type: ${mimeType}`);
    }
    return parseImage(bytes, { ocr: options.ocr });
  }
  throw new UnsupportedFormatError(`unsupported mime type: ${mimeType}`);
}
