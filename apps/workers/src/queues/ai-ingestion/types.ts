/**
 * A single extractable unit of a document, in reading order.
 *
 * A block is either a heading or body text. Headings carry no payload of their own — they exist so
 * the chunker can attach the last-seen heading to the body blocks that follow it as their
 * `section_title`. Keeping the distinction in the block, rather than resolving sections eagerly in
 * the parser, is what lets the DOCX style-driven headings and the PDF heuristic headings feed the
 * same chunker.
 */
export interface ParsedBlock {
  /** The block's text, trimmed. */
  text: string;
  /** `"heading"` blocks set the section context for every block that follows them. */
  kind: "heading" | "body";
  /**
   * The 1-based page the block was extracted from. DOCX has no intrinsic page numbers (Word
   * paginates at render time), so DOCX blocks carry `null`; PDF blocks always carry a page.
   */
  pageNumber: number | null;
}

export interface ParsedDocument {
  format: "pdf" | "docx";
  /** Number of pages, when the format exposes it. `null` for DOCX. */
  pages: number | null;
  blocks: ParsedBlock[];
}

/**
 * One row of `app.material_chunks`: a contiguous slice of a material's extracted text plus its
 * citation anchors. `chunk_index` is the chunk's ordinal within the material (the schema's business
 * key, along with `school_id` and `material_id`).
 */
export interface MaterialChunk {
  chunkIndex: number;
  content: string;
  pageNumber: number | null;
  sectionTitle: string | null;
}
