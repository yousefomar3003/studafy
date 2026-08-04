import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { FIXTURES } from "./__fixtures__/specs";
import { DEFAULT_MAX_CHUNK_CHARS, chunkBlocks } from "./chunker";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, mockEmbedding } from "./embedding";
import { buildIngestChunks } from "./ingest";

import type { ParsedBlock } from "./types";

const readFixture = async (file: string): Promise<Uint8Array> =>
  Bun.file(join(import.meta.dir, "__fixtures__", "files", file)).bytes();

describe("ai-ingestion fixture corpus", () => {
  test("valid documents yield chunks containing their anchors and section headings", async () => {
    for (const spec of FIXTURES) {
      if (spec.kind !== "pdf" && spec.kind !== "docx") continue;
      const chunks = await buildIngestChunks(await readFixture(spec.file), spec.mimeType);

      expect(chunks.length, `${spec.file} produced no chunks`).toBeGreaterThan(0);
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

  test("pdf chunks carry page numbers up to the document page count", async () => {
    for (const spec of FIXTURES) {
      if (spec.kind !== "pdf") continue;
      const chunks = await buildIngestChunks(await readFixture(spec.file), spec.mimeType);
      const pages = chunks
        .map((chunk) => chunk.pageNumber)
        .filter((page): page is number => page !== null);
      expect(pages.length, `${spec.file} lost all page numbers`).toBe(chunks.length);
      expect(Math.max(...pages)).toBe(spec.pages!);
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
});

describe("chunkBlocks", () => {
  test("headings flush the current chunk and become the section title", () => {
    const blocks: ParsedBlock[] = [
      { text: "Introduction", kind: "heading", pageNumber: 1 },
      { text: "First paragraph.", kind: "body", pageNumber: 1 },
      { text: "Second paragraph.", kind: "body", pageNumber: 2 },
      { text: "Methods", kind: "heading", pageNumber: 2 },
      { text: "Method paragraph.", kind: "body", pageNumber: 2 },
    ];
    const chunks = chunkBlocks(blocks);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ sectionTitle: "Introduction", pageNumber: 1 });
    expect(chunks[0]!.content).toBe("First paragraph.\nSecond paragraph.");
    expect(chunks[1]).toMatchObject({ sectionTitle: "Methods", pageNumber: 2 });
    expect(chunks[1]!.content).toBe("Method paragraph.");
  });

  test("no chunk exceeds the character budget and indexes stay sequential", () => {
    const blocks: ParsedBlock[] = [
      { text: "a".repeat(600), kind: "body", pageNumber: 1 },
      { text: "b".repeat(600), kind: "body", pageNumber: 1 },
      { text: "c".repeat(600), kind: "body", pageNumber: 1 },
    ];
    const chunks = chunkBlocks(blocks);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_CHARS);
    }
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
  });

  test("a single block longer than the budget is split without losing text", () => {
    const longText = `Sentence one. Sentence two. ${"Word ".repeat(2000)}`;
    const chunks = chunkBlocks([{ text: longText, kind: "body", pageNumber: 1 }]);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_CHARS);
    }
    expect(chunks.map((chunk) => chunk.content).join(" ")).toContain("Sentence one. Sentence two.");
  });

  test("a heading with no following body creates no chunk", () => {
    expect(chunkBlocks([{ text: "Orphan heading", kind: "heading", pageNumber: 1 }])).toEqual([]);
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
    const chunks = await buildIngestChunks(
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
