// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { AI_SUMMARY_MAX_INPUT_CHARS } from "../config";

import { loadSummaryMaterial } from "./materials";

import type { TransactionSql } from "postgres";

/**
 * The loader is exercised with a fake postgres.js tx that answers the two tenant-scoped queries
 * it issues (`app.materials`, then `app.material_chunks`) from in-memory arrays. The SQL-side
 * scoping (RLS, ORDER BY, LIMIT) is the database's job and is covered by the route test's SQL
 * assertions; here we pin the loader's own behavior: state discrimination and the input-character
 * budget.
 */

const MATERIAL_ID = "20000000-0000-4000-8000-000000000001";

interface MaterialRow {
  id: string;
  title: string | null;
  ingest_status: string;
}

interface ChunkRow {
  id: string;
  chunk_index: number;
  page_number: number | null;
  section_title: string | null;
  content: string;
}

function fakeTx(over: { material?: MaterialRow; chunks?: ChunkRow[] }): TransactionSql {
  const tx = (...args: unknown[]) => {
    const sql = (args[0] as string[]).join("|");
    const rows = sql.includes("FROM app.material_chunks")
      ? (over.chunks ?? [])
      : over.material
        ? [over.material]
        : [];
    return Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve() });
  };
  return tx as unknown as TransactionSql;
}

describe("loadSummaryMaterial", () => {
  test("reports not_found when the tenant cannot see the material", async () => {
    const result = await loadSummaryMaterial(fakeTx({ material: undefined }), MATERIAL_ID);

    expect(result.status).toBe("not_found");
  });

  test("reports not_ready while the material is still mid-ingestion", async () => {
    const result = await loadSummaryMaterial(
      fakeTx({
        material: { id: MATERIAL_ID, title: "Biology", ingest_status: "processing" },
        chunks: [],
      }),
      MATERIAL_ID,
    );

    expect(result.status).toBe("not_ready");
  });

  test("loads a ready material's chunks with their anchors, in chunk order", async () => {
    const chunks: ChunkRow[] = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        chunk_index: 0,
        page_number: 1,
        section_title: "Intro",
        content: "First chunk.",
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        chunk_index: 1,
        page_number: null,
        section_title: null,
        content: "Second chunk.",
      },
    ];

    const result = await loadSummaryMaterial(
      fakeTx({ material: { id: MATERIAL_ID, title: "Biology", ingest_status: "ready" }, chunks }),
      MATERIAL_ID,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.material.id).toBe(MATERIAL_ID);
    expect(result.material.title).toBe("Biology");
    expect(result.material.chunks).toEqual([
      {
        id: chunks[0]!.id,
        chunkIndex: 0,
        pageNumber: 1,
        sectionTitle: "Intro",
        content: "First chunk.",
      },
      {
        id: chunks[1]!.id,
        chunkIndex: 1,
        pageNumber: null,
        sectionTitle: null,
        content: "Second chunk.",
      },
    ]);
  });

  test("fits a contiguous chunk prefix to the input-character budget", async () => {
    const oversized = "x".repeat(AI_SUMMARY_MAX_INPUT_CHARS);
    const chunks: ChunkRow[] = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        chunk_index: 0,
        page_number: null,
        section_title: null,
        content: oversized,
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        chunk_index: 1,
        page_number: null,
        section_title: null,
        content: "dropped",
      },
    ];

    const result = await loadSummaryMaterial(
      fakeTx({ material: { id: MATERIAL_ID, title: null, ingest_status: "ready" }, chunks }),
      MATERIAL_ID,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The first chunk exactly exhausts the budget; the second is dropped rather than sampled, so
    // the model always sees the material's opening, contiguously.
    expect(result.material.chunks).toHaveLength(1);
    expect(result.material.chunks[0]!.content).toHaveLength(AI_SUMMARY_MAX_INPUT_CHARS);
  });

  test("truncates a single oversized chunk to the budget", async () => {
    const chunks: ChunkRow[] = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        chunk_index: 0,
        page_number: null,
        section_title: null,
        content: "y".repeat(AI_SUMMARY_MAX_INPUT_CHARS * 2),
      },
    ];

    const result = await loadSummaryMaterial(
      fakeTx({ material: { id: MATERIAL_ID, title: null, ingest_status: "ready" }, chunks }),
      MATERIAL_ID,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.material.chunks[0]!.content).toHaveLength(AI_SUMMARY_MAX_INPUT_CHARS);
  });
});
