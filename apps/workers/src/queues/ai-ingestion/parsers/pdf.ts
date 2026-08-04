import { extractTextItems, getDocumentProxy } from "unpdf";

import { CorruptDocumentError, EmptyDocumentError, EncryptedDocumentError } from "../errors";

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

export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
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

    const blocks = buildBlocks(lines, bodySize, outline);
    if (blocks.length === 0) {
      throw new EmptyDocumentError("no extractable text");
    }
    return { format: "pdf", pages, blocks };
  } finally {
    await proxy.loadingTask.destroy();
  }
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

function buildBlocks(lines: Line[][], bodySize: number, outline: OutlineSection[]): ParsedBlock[] {
  const outlineByPage = new Map<number, string>();
  for (const section of outline) outlineByPage.set(section.pageIndex, section.title);

  // An outline is the structure; font-size guessing only happens when there is none.
  const useOutline = outline.length > 0;
  const blocks: ParsedBlock[] = [];

  for (const [pageIndex, pageLines] of lines.entries()) {
    const outlineTitle = outlineByPage.get(pageIndex);
    if (outlineTitle) {
      blocks.push({ text: outlineTitle, kind: "heading", pageNumber: pageIndex + 1 });
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
      });
    }
  }
  return blocks;
}

/** pdf.js signals a password-protected document with a PasswordException. */
function isPasswordError(error: unknown): boolean {
  return error instanceof Error && error.name === "PasswordException";
}
