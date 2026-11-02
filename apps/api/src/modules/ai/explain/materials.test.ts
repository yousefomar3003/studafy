// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { AI_EXPLAIN_MAX_INPUT_CHARS } from "../config";

import { loadExplainPassage } from "./materials";

import type { TransactionSql } from "postgres";

/**
 * The loader is exercised with a fake postgres.js tx that answers the single tenant-scoped query it
 * issues (the chunk-materials join) from an in-memory row. The SQL-side scoping (RLS, the
 * tenant-composite join) is the database's job and is covered by the route test's SQL assertions;
 * here we pin the loader's own behavior: state discrimination and the input-character cap.
 */

const CHUNK_ID = "10000000-0000-4000-8000-000000000001";

interface ExplainRow {
  chunk_id: string;
  content: string;
  material_id: string;
  material_title: string | null;
  page_number: number | null;
  section_title: string | null;
  ingest_status: string;
}

function readyRow(over: Partial<ExplainRow> = {}): ExplainRow {
  return {
    chunk_id: CHUNK_ID,
    content: "Photosynthesis converts light energy into chemical energy.",
    material_id: "20000000-0000-4000-8000-000000000001",
    material_title: "Biology",
    page_number: 1,
    section_title: "Photosynthesis",
    ingest_status: "ready",
    ...over,
  };
}

function fakeTx(row?: ExplainRow): TransactionSql {
  const tx = (...args: unknown[]) => {
    const sql = (args[0] as string[]).join("|");
    const rows = sql.includes("FROM app.material_chunks") ? (row ? [row] : []) : [];
    return Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve() });
  };
  return tx as unknown as TransactionSql;
}

describe("loadExplainPassage", () => {
  test("reports not_found when the tenant cannot see the chunk", async () => {
    const result = await loadExplainPassage(fakeTx(), CHUNK_ID);

    expect(result.status).toBe("not_found");
  });

  test("reports not_ready while the chunk's material is still mid-ingestion", async () => {
    const result = await loadExplainPassage(
      fakeTx(readyRow({ ingest_status: "processing" })),
      CHUNK_ID,
    );

    expect(result.status).toBe("not_ready");
  });

  test("loads a ready chunk with its material anchors", async () => {
    const result = await loadExplainPassage(fakeTx(readyRow()), CHUNK_ID);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.chunk).toEqual({
      id: CHUNK_ID,
      content: "Photosynthesis converts light energy into chemical energy.",
      materialId: "20000000-0000-4000-8000-000000000001",
      materialTitle: "Biology",
      pageNumber: 1,
      sectionTitle: "Photosynthesis",
    });
  });

  test("truncates an oversized chunk to the input-character cap", async () => {
    const result = await loadExplainPassage(
      fakeTx(readyRow({ content: "y".repeat(AI_EXPLAIN_MAX_INPUT_CHARS * 2) })),
      CHUNK_ID,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.chunk.content).toHaveLength(AI_EXPLAIN_MAX_INPUT_CHARS);
  });
});
