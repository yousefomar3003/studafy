import type { MaterialChunk, ParsedBlock } from "./types";

export const DEFAULT_MAX_CHUNK_CHARS = 1_000;

/**
 * Fold a document's blocks into retrieval chunks.
 *
 * Body blocks are joined into chunks of at most `maxChunkChars` characters; heading blocks never
 * produce content — they flush the current chunk (so a chunk never straddles a section boundary)
 * and become the `section_title` of everything after them. A chunk inherits the page and section of
 * the first block that contributed to it, which is the anchor a citation renders from.
 */
export function chunkBlocks(
  blocks: readonly ParsedBlock[],
  options: { maxChunkChars?: number } = {},
): MaterialChunk[] {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;

  const chunks: MaterialChunk[] = [];
  let buffer: string[] = [];
  let currentPage: number | null = null;
  let currentSection: string | null = null;
  let currentSlide: number | null = null;
  let nextIndex = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const content = buffer.join("\n").trim();
    buffer = [];
    if (content === "") return;
    chunks.push({
      chunkIndex: nextIndex,
      content,
      pageNumber: currentPage,
      sectionTitle: currentSection,
    });
    nextIndex += 1;
  };

  for (const block of blocks) {
    // A slide is an authoring boundary: PPTX blocks carry their slide and a chunk must never
    // straddle one, even when a slide has no title heading to flush on.
    if (block.slideNumber !== null && block.slideNumber !== currentSlide) {
      flush();
      currentSlide = block.slideNumber;
    }

    if (block.kind === "heading") {
      flush();
      currentSection = block.text;
      if (block.pageNumber !== null) currentPage = block.pageNumber;
      continue;
    }

    const text = block.text.trim();
    if (text === "") continue;

    if (buffer.length > 0 && buffer.join("\n").length + 1 + text.length > maxChunkChars) {
      flush();
    }

    // The page of the first block that starts a chunk, so a chunk spanning a page break is cited
    // from where its content begins.
    if (buffer.length === 0 && block.pageNumber !== null) {
      currentPage = block.pageNumber;
    }

    if (text.length > maxChunkChars) {
      for (const piece of splitLongText(text, maxChunkChars)) {
        chunks.push({
          chunkIndex: nextIndex,
          content: piece,
          pageNumber: currentPage,
          sectionTitle: currentSection,
        });
        nextIndex += 1;
      }
      continue;
    }

    buffer.push(text);
  }

  flush();
  return chunks;
}

/**
 * Split a single body block that exceeds the chunk budget, preferring sentence boundaries.
 *
 * Guarantees every returned piece is at most `max` characters and no piece is empty; the fallback
 * (no boundary found) is a hard cut at the budget.
 */
function splitLongText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    const slice = remaining.slice(0, max);
    let cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\n"));
    if (cut < 0) cut = slice.lastIndexOf("\n");
    if (cut < 0) cut = slice.lastIndexOf(" ");
    if (cut < 0) cut = max - 1;

    pieces.push(slice.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1).trimStart();
    if (remaining.length === 0) return pieces;
  }

  pieces.push(remaining.trim());
  return pieces.filter((piece) => piece !== "");
}
