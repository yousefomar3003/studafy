import { AI_EXAM_CHUNK_LIMIT_PER_MATERIAL, AI_EXAM_MAX_INPUT_CHARS } from "@studafy/constants";

import type { TransactionSql } from "postgres";

/**
 * Multi-material chunk loader for exam generation (ST-171).
 *
 * The same contiguous-prefix-until-budget approach `apps/api/src/modules/ai/quiz/materials.ts` uses
 * for quiz generation, reimplemented locally against raw `postgres.js` rather than the API's
 * `Database` wrapper — this runs inside a worker job, not a request handler. Each material
 * contributes up to `AI_EXAM_CHUNK_LIMIT_PER_MATERIAL` chunks, and the running character budget
 * (`AI_EXAM_MAX_INPUT_CHARS`) is shared across all of them.
 *
 * `tx` must be an open tenant transaction (`withSystemTenantTx`): `app.materials` and
 * `app.material_chunks` are FORCE-RLS on `app.school_id`, so a material belonging to another school
 * reads as absent.
 */
export interface LoadedExamChunk {
  id: string;
  materialId: string;
  materialTitle: string | null;
  chunkIndex: number;
  pageNumber: number | null;
  sectionTitle: string | null;
  content: string;
}

export type LoadExamMaterialsResult =
  | { status: "ok"; chunks: LoadedExamChunk[] }
  | { status: "not_found"; materialId: string }
  | { status: "not_ready"; materialId: string };

/**
 * Load every requested material's ingested text for exam generation, in request order.
 *
 * Fails on the first material that does not exist or is not yet `ingest_status = 'ready'`, naming
 * that material id, so the worker can mark the session `failed` with a specific reason rather than
 * silently generating from fewer materials than requested.
 */
export async function loadExamMaterials(
  tx: TransactionSql,
  materialIds: readonly string[],
): Promise<LoadExamMaterialsResult> {
  const materials: { id: string; title: string | null }[] = [];

  for (const materialId of materialIds) {
    const rows = await tx<{ id: string; title: string | null; ingest_status: string }[]>`
      SELECT id, title, ingest_status
      FROM app.materials
      WHERE id = ${materialId}::uuid
    `;
    const material = rows[0];
    if (!material) return { status: "not_found", materialId };
    if (material.ingest_status !== "ready") return { status: "not_ready", materialId };
    materials.push({ id: material.id, title: material.title });
  }

  let budget = AI_EXAM_MAX_INPUT_CHARS;
  const chunks: LoadedExamChunk[] = [];

  for (const material of materials) {
    if (budget <= 0) break;

    const chunkRows = await tx<
      {
        id: string;
        chunk_index: number;
        page_number: number | null;
        section_title: string | null;
        content: string;
      }[]
    >`
      SELECT id, chunk_index, page_number, section_title, content
      FROM app.material_chunks
      WHERE material_id = ${material.id}::uuid
      ORDER BY chunk_index ASC
      LIMIT ${AI_EXAM_CHUNK_LIMIT_PER_MATERIAL}
    `;

    for (const row of chunkRows) {
      if (budget <= 0) break;
      const content = row.content.slice(0, budget);
      chunks.push({
        id: row.id,
        materialId: material.id,
        materialTitle: material.title,
        chunkIndex: row.chunk_index,
        pageNumber: row.page_number,
        sectionTitle: row.section_title,
        content,
      });
      budget -= content.length;
    }
  }

  return { status: "ok", chunks };
}
