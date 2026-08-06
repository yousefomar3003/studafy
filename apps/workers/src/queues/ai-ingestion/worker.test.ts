import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { FIXTURES } from "./__fixtures__/specs";
import {
  CHUNK_TOKENS,
  DEFAULT_MAX_CHUNK_CHARS,
  OVERLAP_RATIO,
  chunkBlocks,
  estimateTokens,
} from "./chunker";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, mockEmbedding } from "./embedding";
import { buildIngestChunks } from "./ingest";
import { TesseractOcrEngine } from "./ocr";

import type { ParsedBlock } from "./types";

const readFixture = async (file: string): Promise<Uint8Array> =>
  Bun.file(join(import.meta.dir, "__fixtures__", "files", file)).bytes();

describe("ai-ingestion fixture corpus", () => {
  test("valid documents yield chunks containing their anchors and section headings", async () => {
    // One engine for the whole run: it spawns its tesseract worker lazily on the first raster and
    // reuses it, and close() at the end (idempotent, cheap for the text-only formats that never
    // spawned it) guarantees no worker thread leaks out of the test.
    const ocr = new TesseractOcrEngine();
    try {
      for (const spec of FIXTURES) {
        if (!["pdf", "docx", "pptx", "image"].includes(spec.kind)) continue;
        const needsOcr = spec.kind === "image" || spec.file === "scanned-photosynthesis-guide.pdf";
        const { chunks } = await buildIngestChunks(
          await readFixture(spec.file),
          spec.mimeType,
          needsOcr ? { ocr } : {},
        );

        expect(chunks.length, `${spec.file} produced no chunks`).toBeGreaterThan(0);
        const content = chunks.map((chunk) => chunk.content).join("\n");
        for (const anchor of spec.anchors ?? []) {
          expect(content, `${spec.file} lost anchor "${anchor}"`).toContain(anchor);
        }
        const sectionTitles = new Set(chunks.map((chunk) => chunk.sectionTitle).filter(Boolean));
        for (const heading of spec.headings ?? []) {
          expect(
            sectionTitles.has(heading),
            `${spec.file} did not detect heading "${heading}"`,
          ).toBe(true);
        }
      }
    } finally {
      await ocr.close();
    }
  }, 60_000);

  test("pdf chunks carry page numbers up to the document page count", async () => {
    const ocr = new TesseractOcrEngine();
    try {
      for (const spec of FIXTURES) {
        if (spec.kind !== "pdf") continue;
        const needsOcr = spec.file === "scanned-photosynthesis-guide.pdf";
        const { chunks } = await buildIngestChunks(
          await readFixture(spec.file),
          spec.mimeType,
          needsOcr ? { ocr } : {},
        );
        const pages = chunks
          .map((chunk) => chunk.pageNumber)
          .filter((page): page is number => page !== null);
        expect(pages.length, `${spec.file} lost all page numbers`).toBe(chunks.length);
        expect(Math.max(...pages)).toBe(spec.pages!);
      }
    } finally {
      await ocr.close();
    }
  });

  test("pptx decks chunk one per slide with slide-number anchors and captured notes", async () => {
    for (const spec of FIXTURES) {
      if (spec.kind !== "pptx") continue;
      const { chunks } = await buildIngestChunks(await readFixture(spec.file), spec.mimeType);

      expect(chunks, `${spec.file} did not chunk one-per-slide`).toHaveLength(spec.slides!);
      expect(chunks.map((chunk) => chunk.pageNumber)).toEqual(
        Array.from({ length: spec.slides! }, (_, index) => index + 1),
      );

      const content = chunks.map((chunk) => chunk.content).join("\n");
      for (const anchor of spec.anchors ?? []) {
        expect(content, `${spec.file} lost anchor "${anchor}"`).toContain(anchor);
      }
      const sectionTitles = new Set(chunks.map((chunk) => chunk.sectionTitle).filter(Boolean));
      for (const heading of spec.headings ?? []) {
        expect(sectionTitles.has(heading), `${spec.file} did not detect heading "${heading}"`).toBe(
          true,
        );
      }
    }
  });

  test("corrupt and unsupported documents reject with a stable reason", async () => {
    for (const spec of FIXTURES) {
      if (spec.kind !== "corrupt" && spec.kind !== "unsupported") continue;
      await expect(
        buildIngestChunks(await readFixture(spec.file), spec.mimeType),
      ).rejects.toMatchObject({
        reason: spec.ingestError,
      });
    }
  });

  test("chunks stay within the token budget, keep their anchors, and are deterministic across the corpus", async () => {
    for (const spec of FIXTURES) {
      // OCR fixtures are excluded: the chunker is deterministic by construction, and re-running the
      // engine doubles the tesseract load for a property the unit tests already pin.
      if (!["pdf", "docx", "pptx"].includes(spec.kind)) continue;
      if (spec.file === "scanned-photosynthesis-guide.pdf") continue;

      const first = await buildIngestChunks(await readFixture(spec.file), spec.mimeType);
      const second = await buildIngestChunks(await readFixture(spec.file), spec.mimeType);

      expect(second.chunks, `${spec.file} chunking is not deterministic`).toEqual(first.chunks);
      first.chunks.forEach((chunk, index) => {
        expect(chunk.chunkIndex, `${spec.file} chunk ${index} index`).toBe(index);
        expect(
          estimateTokens(chunk.content),
          `${spec.file} chunk ${index} exceeds the token budget`,
        ).toBeLessThanOrEqual(CHUNK_TOKENS);
        expect(
          chunk.content.length,
          `${spec.file} chunk ${index} exceeds the character budget`,
        ).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_CHARS);
      });
    }
  });
});

describe("chunkBlocks", () => {
  test("headings flush the current chunk and become the section title", () => {
    const blocks: ParsedBlock[] = [
      { text: "Introduction", kind: "heading", pageNumber: 1, slideNumber: null },
      { text: "First paragraph.", kind: "body", pageNumber: 1, slideNumber: null },
      { text: "Second paragraph.", kind: "body", pageNumber: 2, slideNumber: null },
      { text: "Methods", kind: "heading", pageNumber: 2, slideNumber: null },
      { text: "Method paragraph.", kind: "body", pageNumber: 2, slideNumber: null },
    ];
    const chunks = chunkBlocks(blocks);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ sectionTitle: "Introduction", pageNumber: 1 });
    expect(chunks[0]!.content).toBe("First paragraph.\nSecond paragraph.");
    expect(chunks[1]).toMatchObject({ sectionTitle: "Methods", pageNumber: 2 });
    expect(chunks[1]!.content).toBe("Method paragraph.");
  });

  test("a slide boundary flushes the chunk even without a heading", () => {
    const blocks: ParsedBlock[] = [
      { text: "First slide bullet.", kind: "body", pageNumber: 1, slideNumber: 1 },
      { text: "Second slide bullet.", kind: "body", pageNumber: 2, slideNumber: 2 },
      { text: "Second slide note.", kind: "body", pageNumber: 2, slideNumber: 2 },
    ];
    const chunks = chunkBlocks(blocks);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ pageNumber: 1, content: "First slide bullet." });
    expect(chunks[1]).toMatchObject({
      pageNumber: 2,
      content: "Second slide bullet.\nSecond slide note.",
    });
  });

  test("no chunk exceeds the character budget and indexes stay sequential", () => {
    const blocks: ParsedBlock[] = [
      { text: "a".repeat(600), kind: "body", pageNumber: 1, slideNumber: null },
      { text: "b".repeat(600), kind: "body", pageNumber: 1, slideNumber: null },
      { text: "c".repeat(600), kind: "body", pageNumber: 1, slideNumber: null },
    ];
    const chunks = chunkBlocks(blocks, { maxChunkChars: 1_000, overlapChars: 150 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1_000);
    }
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
  });

  test("a single block longer than the budget is split without losing text", () => {
    const longText = `Sentence one. Sentence two. ${"Word ".repeat(2000)}`;
    const chunks = chunkBlocks(
      [{ text: longText, kind: "body", pageNumber: 1, slideNumber: null }],
      { maxChunkChars: 1_000, overlapChars: 150 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1_000);
    }
    expect(chunks.map((chunk) => chunk.content).join(" ")).toContain("Sentence one. Sentence two.");
  });

  test("a heading with no following body creates no chunk", () => {
    expect(
      chunkBlocks([{ text: "Orphan heading", kind: "heading", pageNumber: 1, slideNumber: null }]),
    ).toEqual([]);
  });

  test("adjacent chunks share the configured overlap within a section", () => {
    const sentence =
      "The chloroplast is the organelle where photosynthesis stores chemical energy. ";
    const blocks: ParsedBlock[] = [
      { text: sentence.repeat(60), kind: "body", pageNumber: 1, slideNumber: null },
    ];
    const chunks = chunkBlocks(blocks, { maxChunkChars: 1_000, overlapChars: 150 });

    expect(chunks.length).toBeGreaterThan(2);
    for (let index = 1; index < chunks.length; index += 1) {
      // The next chunk opens inside the previous chunk's tail — the overlap.
      const overlapProbe = chunks[index]!.content.slice(0, 60);
      expect(
        chunks[index - 1]!.content.slice(-200),
        `chunks ${index - 1} and ${index} share no overlap`,
      ).toContain(overlapProbe);
    }
  });

  test("overlap never crosses a section heading", () => {
    const firstSection = "The Calvin cycle fixes carbon dioxide into organic molecules. ";
    const secondSection = "Chlorophyll absorbs mostly red and blue light. ";
    const blocks: ParsedBlock[] = [
      { text: firstSection.repeat(40), kind: "body", pageNumber: 1, slideNumber: null },
      { text: "Light Reactions", kind: "heading", pageNumber: 2, slideNumber: null },
      { text: secondSection.repeat(40), kind: "body", pageNumber: 2, slideNumber: null },
    ];
    const chunks = chunkBlocks(blocks, { maxChunkChars: 1_000, overlapChars: 150 });

    const sectionStart = chunks.findIndex((chunk) => chunk.sectionTitle === "Light Reactions");
    expect(sectionStart).toBeGreaterThan(0);
    // A fresh section opens with its own text: the previous chunk's overlap tail never carries over,
    // which would otherwise prefix this chunk with "The Calvin cycle" and break the start.
    expect(chunks[sectionStart]!.content.startsWith("Chlorophyll absorbs")).toBe(true);
  });

  test("overlap does not carry across a heading that follows a size flush", () => {
    // Section one ends exactly on a size-induced flush (a split piece left behind an overlap tail),
    // and the next heading sits on the same page — the case that used to leak the tail across.
    const blocks: ParsedBlock[] = [
      { text: "A".repeat(90), kind: "body", pageNumber: 1, slideNumber: null },
      { text: "B".repeat(90), kind: "body", pageNumber: 1, slideNumber: null },
      { text: "Section Two", kind: "heading", pageNumber: 1, slideNumber: null },
      { text: "C".repeat(90), kind: "body", pageNumber: 1, slideNumber: null },
    ];
    const chunks = chunkBlocks(blocks, { maxChunkChars: 100, overlapChars: 15 });

    const sectionTwoStart = chunks.findIndex((chunk) => chunk.sectionTitle === "Section Two");
    expect(sectionTwoStart).toBeGreaterThan(0);
    expect(chunks[sectionTwoStart]!.content.startsWith("C")).toBe(true);
  });

  test("overlap never crosses a slide boundary", () => {
    const firstSlide = "The Sun contains most of the mass of the solar system. ";
    const secondSlide = "Jupiter is the largest planet by mass. ";
    const blocks: ParsedBlock[] = [
      { text: firstSlide.repeat(40), kind: "body", pageNumber: 1, slideNumber: 1 },
      { text: secondSlide.repeat(40), kind: "body", pageNumber: 2, slideNumber: 2 },
    ];
    const chunks = chunkBlocks(blocks, { maxChunkChars: 1_000, overlapChars: 150 });

    const last = chunks[chunks.length - 1]!;
    expect(last.pageNumber).toBe(2);
    // A leaked slide-1 tail would prefix this chunk with "The Sun contains" and break the start.
    expect(last.content.startsWith("Jupiter is the largest planet")).toBe(true);
  });

  test("overlap never crosses a page boundary", () => {
    const sentence = "The nucleus stores genetic material in chromosomes. ";
    const blocks: ParsedBlock[] = [
      { text: sentence.repeat(40), kind: "body", pageNumber: 1, slideNumber: null },
      {
        text: "The nuclear envelope has pores that control what enters and leaves.",
        kind: "body",
        pageNumber: 2,
        slideNumber: null,
      },
    ];
    const chunks = chunkBlocks(blocks, { maxChunkChars: 1_000, overlapChars: 150 });

    const pageTwoStart = chunks.findIndex((chunk) => chunk.pageNumber === 2);
    expect(pageTwoStart).toBeGreaterThan(0);
    // A leaked page-1 tail would prefix this chunk with "The nucleus" and break the start.
    expect(chunks[pageTwoStart]!.content.startsWith("The nuclear envelope")).toBe(true);
  });

  test("every chunk carries its material ordinal and page/section anchors", () => {
    const blocks: ParsedBlock[] = [
      { text: "Introduction", kind: "heading", pageNumber: 1, slideNumber: null },
      { text: "First paragraph.", kind: "body", pageNumber: 1, slideNumber: null },
      { text: "Second paragraph.", kind: "body", pageNumber: 2, slideNumber: null },
      { text: "Methods", kind: "heading", pageNumber: 2, slideNumber: null },
      { text: "Method paragraph.", kind: "body", pageNumber: 2, slideNumber: null },
    ];
    const chunks = chunkBlocks(blocks);

    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
    for (const chunk of chunks) {
      expect(chunk.pageNumber).not.toBeNull();
      expect(chunk.sectionTitle).not.toBeNull();
    }
  });

  test("output is deterministic for identical input", () => {
    const sentence = "The mitochondria generate ATP for cellular work. ";
    const blocks: ParsedBlock[] = [
      { text: "Biology", kind: "heading", pageNumber: 1, slideNumber: null },
      { text: sentence.repeat(60), kind: "body", pageNumber: 1, slideNumber: null },
      { text: sentence.repeat(30), kind: "body", pageNumber: 2, slideNumber: null },
    ];
    const options = { maxChunkChars: 1_000, overlapChars: 150 };

    expect(chunkBlocks(blocks, options)).toEqual(chunkBlocks(blocks, options));
  });

  test("continuous text is split at the ~800 token target and never over it", () => {
    const sentence =
      "Photosynthesis converts light energy into chemical energy stored in glucose. ";
    const chunks = chunkBlocks([
      { text: sentence.repeat(400), kind: "body", pageNumber: 1, slideNumber: null },
    ]);

    const tokens = chunks.map((chunk) => estimateTokens(chunk.content));
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...tokens)).toBeLessThanOrEqual(CHUNK_TOKENS);
    // The splitter actually fills chunks toward the budget rather than carving thin slivers.
    expect(Math.max(...tokens)).toBeGreaterThan(Math.round(CHUNK_TOKENS * (1 - OVERLAP_RATIO)));
  });
});

describe("mockEmbedding", () => {
  test("is deterministic and a 1536-dimension pgvector literal", () => {
    const first = mockEmbedding("photosynthesis light");
    expect(mockEmbedding("photosynthesis light")).toBe(first);
    expect(mockEmbedding("photosynthesis dark")).not.toBe(first);

    const parts = first.slice(1, -1).split(",");
    expect(parts).toHaveLength(EMBEDDING_DIMENSIONS);
    for (const part of parts) expect(Number.isFinite(Number(part))).toBe(true);
  });

  test("every chunk carries the embedding model and a vector literal", async () => {
    const { chunks } = await buildIngestChunks(
      await readFixture("algebra-functions.pdf"),
      "application/pdf",
    );
    for (const chunk of chunks) {
      expect(chunk.embeddingModel).toBe(EMBEDDING_MODEL);
      expect(chunk.embedding.startsWith("[")).toBe(true);
      expect(chunk.embedding.endsWith("]")).toBe(true);
      expect(chunk.embedding.slice(1, -1).split(",")).toHaveLength(EMBEDDING_DIMENSIONS);
    }
  });
});
