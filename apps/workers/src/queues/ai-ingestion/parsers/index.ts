import { UnsupportedFormatError } from "../errors";

import { parseDocx } from "./docx";
import { parsePdf } from "./pdf";

import type { ParsedDocument } from "../types";

/** MIME types the ingestion pipeline can parse, and their parsers. */
const PDF_MIME_TYPES = new Set(["application/pdf", "application/x-pdf", "text/pdf"]);
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Parse a document's bytes into reading-order blocks. The format is chosen by the material's stored
 * MIME type; anything else is rejected before any bytes are interpreted. No shell-outs: parsing is
 * pure in-process library work, so a hostile file can neither spawn processes nor reach the
 * filesystem.
 */
export async function parseDocument(bytes: Uint8Array, mimeType: string): Promise<ParsedDocument> {
  if (PDF_MIME_TYPES.has(mimeType)) {
    return parsePdf(bytes);
  }
  if (mimeType === DOCX_MIME_TYPE) {
    return parseDocx(bytes);
  }
  throw new UnsupportedFormatError(`unsupported mime type: ${mimeType}`);
}
