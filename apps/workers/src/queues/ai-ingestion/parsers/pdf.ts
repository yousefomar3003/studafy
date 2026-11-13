import { extractTextItems, getDocumentProxy, renderPageAsImage } from "unpdf";

import { CorruptDocumentError, EmptyDocumentError, EncryptedDocumentError } from "../errors";

import type { OcrEngine, OcrPageResult, OcrReport } from "../ocr";
import type { ParsedBlock, ParsedDocument } from "../types";
import type { StructuredTextItem } from "unpdf";

/**
 * A line of text on one page, with the largest font size used on it. Font size is the only
 * structural signal a text-only PDF reliably exposes, and it is the basis for the heading heuristic
 * below (see HEADING_FONT_RATIO).
 */
interface Line {
  page: number;
  size: number;
  text: string;
}

interface OutlineSection {
  pageIndex: number;
  title: string;
}

/**
 * A line is a heading if its font size stands out from the body text and it is short. Body size is
 * the median line size across the document, so the heuristic survives pages whose body text is
 * rendered larger or smaller than average. Best-effort by construction: a text-only PDF has no
 * style semantics, so this can only be a heuristic — the DOCX parser gets real heading styles.
 */
const HEADING_FONT_RATIO = 1.4;
const MAX_HEADING_CHARS = 120;
const LINE_Y_TOLERANCE = 2;

export interface ParsePdfOptions {
  /**
   * The OCR engine used for pages with no extractable text (scanned pages). Optional because a text
   * PDF never needs it; a scanned PDF without an engine is a configuration gap and fails with
   * `EmptyDocumentError` just as it would have before OCR existed.
   */
  ocr?: OcrEngine;
}

/**
 * Parse a PDF into blocks. Text pages are extracted and heuristically headed exactly as before;
 * pages with no extractable text (scans, embedded rasters) are handed to the OCR engine, one
 * rendered raster per page, and their recognized text becomes one body block at the page's
 * position. The {@link OcrReport} records every OCR'd page so low-confidence pages can be flagged.
 * Rendering pages is the slow path, and only pages that need it pay for it.
 */
export async function parsePdf(
  bytes: Uint8Array,
  options: ParsePdfOptions = {},
): Promise<ParsedDocument> {
  let proxy: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    proxy = await getDocumentProxy(bytes);
  } catch (error) {
    if (isPasswordError(error)) {
      throw new EncryptedDocumentError("file is password-protected");
    }
    throw new CorruptDocumentError("file is not a valid PDF");
  }

  try {
    const pages = proxy.numPages;
    const { items } = await extractTextItems(proxy);
    const lines = linesPerPage(items);
    const bodySize = dominantFontSize(lines);
    const outline = await readOutline(proxy);

    const ocrByPage = new Map<number, OcrPageResult>();
    if (options.ocr) {
      for (const [pageIndex, pageLines] of lines.entries()) {
        if (pageLines.length > 0) continue;
        const pageNumber = pageIndex + 1;
        const result = await ocrPage(options.ocr, proxy, pageNumber);
        ocrByPage.set(pageIndex, result);
      }
    }

    const blocks = buildBlocks(lines, bodySize, outline, ocrByPage);
    if (blocks.length === 0) {
      throw new EmptyDocumentError("no extractable text");
    }
    const ocrReport: OcrReport | null =
      ocrByPage.size > 0 && options.ocr
        ? {
            engine: options.ocr.name,
            lowConfidenceThreshold: options.ocr.lowConfidenceThreshold,
            pages: [...ocrByPage.values()].sort((a, b) => a.page - b.page),
          }
        : null;
    return { format: "pdf", pages, blocks, ocrReport };
  } finally {
    await proxy.loadingTask.destroy();
  }
}

/**
 * Render one page of the PDF to a raster and recognize it. `renderPageAsImage` returns an
 * `ArrayBuffer`; `new Uint8Array` copies it so the engine owns the bytes. Scale 2 doubles the
 * resolution of a typical 72pt scan to roughly what a phone camera produces, which is where
 * tesseract's accuracy plateaus for clean print (verified against the fixtures, ADR 0007).
 */
async function ocrPage(
  ocr: OcrEngine,
  proxy: Awaited<ReturnType<typeof getDocumentProxy>>,
  page: number,
): Promise<OcrPageResult> {
  const rendered = await renderPageAsImage(proxy, page, {
    canvasImport: () => import("@napi-rs/canvas"),
    scale: 2,
  });
  return ocr.recognize(new Uint8Array(rendered), page);
}

/** Group a page's text items into lines by vertical position, top of page first. */
function linesPerPage(items: StructuredTextItem[][]): Line[][] {
  return items.map((pageItems, pageIndex) => {
    const page = pageIndex + 1;
    const sorted = [...pageItems]
      .filter((item) => item.str.length > 0)
      .sort((a, b) => b.y - a.y || a.x - b.x);

    const lines: Line[] = [];
    let group: StructuredTextItem[] = [];
    let baseline = 0;

    const pushGroup = (): void => {
      if (group.length === 0) return;
      const ordered = [...group].sort((a, b) => a.x - b.x);
      const size = Math.max(...ordered.map((item) => item.fontSize));
      const text = ordered
        .map((item) => item.str)
        .join("")
        .trim();
      if (text !== "") {
        lines.push({ page, size, text });
      }
      group = [];
    };

    for (const item of sorted) {
      if (group.length > 0 && Math.abs(item.y - baseline) > LINE_Y_TOLERANCE) {
        pushGroup();
      }
      if (group.length === 0) baseline = item.y;
      group.push(item);
    }
    pushGroup();
    return lines;
  });
}

/** The median line font size across the document: the "normal" body size headings are judged against. */
function dominantFontSize(lines: Line[][]): number {
  const sizes = lines
    .flat()
    .map((line) => line.size)
    .filter((size) => size > 0)
    .sort((a, b) => a - b);
  if (sizes.length === 0) return 0;
  return sizes[Math.floor(sizes.length / 2)]!;
}

/**
 * Read the document outline (bookmarks), resolved to 0-based page indexes.
 *
 * When a PDF has an outline, its titles are the authoritative section names — that is what the
 * author (or their publishing tool) chose to structure the document with, and it is strictly better
 * than inferring headings from font size. The heuristic is used only for outline-less PDFs.
 */
async function readOutline(
  proxy: Awaited<ReturnType<typeof getDocumentProxy>>,
): Promise<OutlineSection[]> {
  try {
    const outline = await proxy.getOutline();
    if (!outline) return [];
    const sections: OutlineSection[] = [];
    for (const item of outline) {
      if (item.title.trim() === "") continue;
      const pageIndex = await pageIndexOf(proxy, item.dest);
      if (pageIndex !== null) sections.push({ pageIndex, title: item.title.trim() });
    }
    return sections;
  } catch {
    return [];
  }
}

async function pageIndexOf(
  proxy: Awaited<ReturnType<typeof getDocumentProxy>>,
  dest: string | unknown[] | null,
): Promise<number | null> {
  try {
    if (Array.isArray(dest) && dest.length > 0) {
      const first = dest[0];
      if (typeof first === "number") return first - 1;
      if (first !== null && typeof first === "object" && "num" in first) {
        return proxy.getPageIndex(first as never);
      }
      return null;
    }
    if (typeof dest === "string") {
      const resolved = await proxy.getDestination(dest);
      return resolved ? pageIndexOf(proxy, resolved) : null;
    }
    return null;
  } catch {
    return null;
  }
}

function buildBlocks(
  lines: Line[][],
  bodySize: number,
  outline: OutlineSection[],
  ocrByPage: Map<number, OcrPageResult> = new Map<number, OcrPageResult>(),
): ParsedBlock[] {
  const outlineByPage = new Map<number, string>();
  for (const section of outline) outlineByPage.set(section.pageIndex, section.title);

  // An outline is the structure; font-size guessing only happens when there is none.
  const useOutline = outline.length > 0;
  const blocks: ParsedBlock[] = [];

  for (const [pageIndex, pageLines] of lines.entries()) {
    const outlineTitle = outlineByPage.get(pageIndex);
    if (outlineTitle) {
      blocks.push({
        text: outlineTitle,
        kind: "heading",
        pageNumber: pageIndex + 1,
        slideNumber: null,
      });
    }
    for (const line of pageLines) {
      if (line.text === "") continue;
      const heading =
        !useOutline &&
        line.size >= bodySize * HEADING_FONT_RATIO &&
        line.text.length <= MAX_HEADING_CHARS;
      blocks.push({
        text: line.text,
        kind: heading ? "heading" : "body",
        pageNumber: pageIndex + 1,
        slideNumber: null,
      });
    }
    // An OCR'd page has no text lines, so its recognized text lands at the page's own position,
    // keeping reading order intact for mixed documents.
    const ocr = ocrByPage.get(pageIndex);
    if (ocr !== undefined && ocr.text !== "") {
      blocks.push({
        text: ocr.text,
        kind: "body",
        pageNumber: pageIndex + 1,
        slideNumber: null,
      });
    }
  }
  return blocks;
}

/** pdf.js signals a password-protected document with a PasswordException. */
function isPasswordError(error: unknown): boolean {
  return error instanceof Error && error.name === "PasswordException";
}
