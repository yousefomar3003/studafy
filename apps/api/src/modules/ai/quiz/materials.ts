import { AI_QUIZ_CHUNK_LIMIT_PER_MATERIAL, AI_QUIZ_MAX_INPUT_CHARS } from "../config";

import type { TransactionSql } from "postgres";

/**
 * Multi-material chunk loader for quiz generation (ST-167).
 *
 * The same contiguous-prefix-until-budget approach `summary/materials.ts` uses for one material,
 * extended across every material the request selected, in the order given: each material
 * contributes up to `AI_QUIZ_CHUNK_LIMIT_PER_MATERIAL` chunks, and the running character budget
 * (`AI_QUIZ_MAX_INPUT_CHARS`) is shared across all of them, so a request with several materials still
 * gets a bounded prompt rather than N times the per-material cap.
 *
 * `tx` must be an open tenant transaction: `app.materials` and `app.material_chunks` are FORCE-RLS
 * on `app.school_id`, so a material belonging to another school reads as absent -- the correct
 * security posture (cross-tenant lookup is indistinguishable from nonexistence).
 */
export interface LoadedQuizChunk {
  id: string;
  materialId: string;
  materialTitle: string | null;
  chunkIndex: number;
  pageNumber: number | null;
  sectionTitle: string | null;
  content: string;
}

export type LoadQuizMaterialsResult =
  | { status: "ok"; chunks: LoadedQuizChunk[] }
  | { status: "not_found"; materialId: string }
  | { status: "not_ready"; materialId: string };

/**
 * Load every requested material's ingested text for quiz generation, in request order.
 *
 * Fails on the first material that does not exist or is not yet `ingest_status = 'ready'`, naming
 * that material id, so the route can answer 404 or 422 rather than silently generating a quiz from
 * fewer materials than the caller asked for. Once every material is confirmed valid, chunks are
 * pulled until either the per-material cap or the shared character budget is exhausted -- a material
 * later in the list can end up contributing zero chunks if earlier ones already spent the budget.
 */
export async function loadQuizMaterials(
  tx: TransactionSql,
  materialIds: readonly string[],
): Promise<LoadQuizMaterialsResult> {
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

  let budget = AI_QUIZ_MAX_INPUT_CHARS;
  const chunks: LoadedQuizChunk[] = [];

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
      LIMIT ${AI_QUIZ_CHUNK_LIMIT_PER_MATERIAL}
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
