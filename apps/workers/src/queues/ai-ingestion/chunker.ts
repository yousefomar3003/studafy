import type { MaterialChunk, ParsedBlock } from "./types";

/**
 * The retrieval chunk budget, expressed in tokens. The repository has no tokenizer — the embedding
 * pipeline is mock (`EMBEDDING_MODEL = "mock-embedding-3-small"`, no client declared) — so tokens
 * are an approximation: English runs at roughly four characters per token, the canonical rule of
 * thumb. The chunker stays a character machine (deterministic, no dependency); the character budget
 * it enforces is `CHUNK_TOKENS * CHARS_PER_TOKEN`.
 */
export const CHUNK_TOKENS = 800;
export const CHARS_PER_TOKEN = 4;
/** The share of a chunk repeated at the start of the next, so no sentence is lost at a boundary. */
export const OVERLAP_RATIO = 0.15;

export const DEFAULT_MAX_CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN;
export const DEFAULT_OVERLAP_CHARS = Math.round(DEFAULT_MAX_CHUNK_CHARS * OVERLAP_RATIO);

/**
 * The token count the chunk-size tests assert against: the same four-chars-per-token rule the
 * budget is derived from, so a chunk at the character budget reads as exactly `CHUNK_TOKENS` tokens.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface ChunkBlocksOptions {
  /** At most this many characters per chunk (default `DEFAULT_MAX_CHUNK_CHARS`). */
  maxChunkChars?: number;
  /** At most this many trailing characters of a chunk repeated into the next (default `DEFAULT_OVERLAP_CHARS`). */
  overlapChars?: number;
}

/**
 * Fold a document's blocks into retrieval chunks of at most `maxChunkChars` characters, targeting
 * ~`CHUNK_TOKENS` tokens each.
 *
 * Heading blocks never produce content — they flush the current chunk (so a chunk never straddles a
 * section boundary) and become the `section_title` of everything after them. A chunk inherits the
 * page and section of the first block that contributed to it, which is the anchor a citation renders
 * from.
 *
 * Consecutive chunks share up to `overlapChars` characters so a retrieval boundary never drops a
 * sentence. Overlap only carries across a size-induced flush: it never crosses a section heading,
 * a slide, or a page, so every chunk's text stays citable to the page and section it is anchored on.
 * Each chunk also carries its ordinal within the material (`chunkIndex`); material identity is the
 * `(school_id, material_id, chunk_index)` key held by the caller, so no material metadata is copied
 * onto a chunk (see `docs/api/material-chunks-data-model.md`).
 *
 * Output is a pure function of the input: the same blocks produce byte-identical chunks.
 */
export function chunkBlocks(
  blocks: readonly ParsedBlock[],
  options: ChunkBlocksOptions = {},
): MaterialChunk[] {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  // Overlap is capped at half the budget so a seeded overlap plus new text can always fit.
  const overlapChars = Math.min(
    options.overlapChars ?? DEFAULT_OVERLAP_CHARS,
    Math.floor(maxChunkChars / 2),
  );

  const chunks: MaterialChunk[] = [];
  let buffer: string[] = [];
  let currentPage: number | null = null;
  let currentSection: string | null = null;
  let currentSlide: number | null = null;
  let nextIndex = 0;
  // The page/slide of the last real body block appended to the open chunk, plus whether one has been
  // appended at all. `anchorPending` keeps the citation page on the first contributing block even
  // when the chunk opens with an overlap seed, which belongs to the same page by construction.
  let lastBlockPage: number | null = null;
  let lastBlockSlide: number | null = null;
  let hasRealBlocks = false;
  let anchorPending = true;
  // The overlap tail of the most recent size-flush, and the page/slide it was cut from. It is seeded
  // into the next chunk only when that chunk's first block shares that page and slide, so overlap
  // never makes a citation point at the wrong page.
  let carry: string | null = null;
  let carryPage: number | null = null;
  let carrySlide: number | null = null;

  const flush = (carryEligible: boolean): void => {
    if (buffer.length === 0) {
      // A heading or slide boundary must never let the previous chunk's overlap tail ride across
      // it. With nothing buffered there is nothing to carry from, so drop any pending carry — a
      // size-flush never reaches this point because it always leaves a seeded chunk behind.
      if (!carryEligible) {
        carry = null;
        carryPage = null;
        carrySlide = null;
      }
      return;
    }
    const content = buffer.join("\n").trim();
    buffer = [];
    if (content === "") {
      carry = null;
      return;
    }
    chunks.push({
      chunkIndex: nextIndex,
      content,
      pageNumber: currentPage,
      sectionTitle: currentSection,
    });
    nextIndex += 1;
    const tail = carryEligible ? overlapTail(content, overlapChars) : "";
    carry = tail === "" ? null : tail;
    carryPage = carry === null ? null : lastBlockPage;
    carrySlide = carry === null ? null : lastBlockSlide;
    hasRealBlocks = false;
    anchorPending = true;
    lastBlockPage = null;
    lastBlockSlide = null;
  };

  for (const block of blocks) {
    // A slide is an authoring boundary: PPTX blocks carry their slide and a chunk must never
    // straddle one, even when a slide has no title heading to flush on.
    if (block.slideNumber !== null && block.slideNumber !== currentSlide) {
      flush(false);
      currentSlide = block.slideNumber;
    }

    if (block.kind === "heading") {
      flush(false);
      currentSection = block.text;
      if (block.pageNumber !== null) currentPage = block.pageNumber;
      continue;
    }

    const text = block.text.trim();
    if (text === "") continue;

    if (hasRealBlocks && buffer.join("\n").length + 1 + text.length > maxChunkChars) {
      flush(true);
    }

    // The overlap tail rides into the next chunk only when the anchor holds, so a chunk's text is
    // always citable to the page it is anchored on.
    if (
      buffer.length === 0 &&
      carry !== null &&
      block.pageNumber === carryPage &&
      block.slideNumber === carrySlide
    ) {
      buffer.push(carry);
      carry = null;
    }

    if (anchorPending && block.pageNumber !== null) currentPage = block.pageNumber;
    anchorPending = false;

    // A block that cannot fit even in a fresh chunk is split; a seeded overlap tail counts against
    // the budget, so the first piece is windowed to leave room for it.
    const seededChars = buffer.join("\n").length;
    if (
      text.length > maxChunkChars ||
      (buffer.length > 0 && seededChars + 1 + text.length > maxChunkChars)
    ) {
      const prefixChars = buffer.length > 0 ? seededChars + 1 : 0;
      const pieces = splitLongText(text, maxChunkChars, overlapChars, prefixChars);
      const prefix = buffer.join("\n");
      buffer = [];
      pieces.forEach((piece, index) => {
        chunks.push({
          chunkIndex: nextIndex,
          content: index === 0 && prefix !== "" ? `${prefix}\n${piece}` : piece,
          pageNumber: currentPage,
          sectionTitle: currentSection,
        });
        nextIndex += 1;
      });
      const tail = overlapTail(pieces[pieces.length - 1]!, overlapChars);
      carry = tail === "" ? null : tail;
      carryPage = block.pageNumber;
      carrySlide = block.slideNumber;
      lastBlockPage = block.pageNumber;
      lastBlockSlide = block.slideNumber;
      // The pieces already consumed this block's anchor; the next block opens a fresh chunk.
      anchorPending = true;
      continue;
    }

    buffer.push(text);
    hasRealBlocks = true;
    lastBlockPage = block.pageNumber;
    lastBlockSlide = block.slideNumber;
  }

  flush(false);
  return chunks;
}

/**
 * Split a single body block that exceeds the budget, preferring boundaries near the end of each
 * window so consecutive pieces overlap by up to `overlap` characters without losing a sentence.
 *
 * The first piece leaves `prefixChars` characters of room for an overlap seed carried in from the
 * previous chunk. Every returned piece is at most `max` characters and non-empty; when no boundary
 * lands in the trailing overlap region the piece ends with a hard cut at the budget.
 */
function splitLongText(text: string, max: number, overlap: number, prefixChars: number): string[] {
  const pieces: string[] = [];
  let remaining = text;
  let budget = max - prefixChars;

  while (remaining.length > budget) {
    const slice = remaining.slice(0, budget);
    const cut = cutIndex(slice, budget, overlap);

    pieces.push(slice.slice(0, cut + 1).trim());

    // Re-open `overlap` characters of the cut piece so the next one shares them, capped so the
    // remaining text always advances, then back off to a word boundary so a chunk never opens
    // mid-word. Overlap therefore lands between the configured share and one word more of it.
    const overlapHere = Math.min(overlap, cut, budget - 1);
    let start = cut + 1 - overlapHere;
    const wordStart = remaining.lastIndexOf(" ", start);
    if (wordStart !== -1 && start - wordStart <= overlap) start = wordStart + 1;
    remaining = remaining.slice(start).trimStart();
    budget = max;
  }

  pieces.push(remaining.trim());
  return pieces.filter((piece) => piece !== "");
}

/**
 * Where to cut a window: the last sentence break (`. ` / `.\n`), line break, or space inside the
 * trailing overlap region — the region the next window will re-open — so the overlap stays near the
 * configured ratio instead of ballooning. With no overlap requested (`overlap === 0`) the whole
 * window is searched, as a plain character splitter would. Hard cut at the budget as the fallback.
 */
function cutIndex(slice: string, budget: number, overlap: number): number {
  const regionStart = overlap > 0 ? Math.max(0, budget - overlap) : 0;
  const region = slice.slice(regionStart);
  let cut = Math.max(region.lastIndexOf(". "), region.lastIndexOf(".\n"));
  if (cut < 0) cut = region.lastIndexOf("\n");
  if (cut < 0) cut = region.lastIndexOf(" ");
  if (cut < 0) {
    return budget - 1;
  }
  return cut + regionStart;
}

/**
 * The trailing `overlapChars` characters of a chunk, nudged forward to the next space so the carry
 * never starts mid-word. Returns the whole chunk when it is shorter than the overlap.
 */
function overlapTail(content: string, overlapChars: number): string {
  if (overlapChars <= 0) return "";
  if (content.length <= overlapChars) return content;
  let start = content.length - overlapChars;
  const nextSpace = content.indexOf(" ", start);
  if (nextSpace !== -1 && nextSpace < content.length - 1) start = nextSpace + 1;
  return content.slice(start);
}
