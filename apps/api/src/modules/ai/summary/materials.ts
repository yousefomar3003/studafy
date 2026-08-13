import { AI_SUMMARY_CHUNK_LIMIT, AI_SUMMARY_MAX_INPUT_CHARS } from "../config";

import type { TransactionSql } from "postgres";

/**
 * One ingested text chunk of the material being summarized, in source order.
 */
export interface LoadedSummaryChunk {
  id: string;
  chunkIndex: number;
  pageNumber: number | null;
  sectionTitle: string | null;
  content: string;
}

/** The material's identity plus the chunks the summary will be grounded on. */
export interface LoadedSummaryMaterial {
  id: string;
  title: string | null;
  chunks: LoadedSummaryChunk[];
}

export type LoadSummaryMaterialResult =
  | { status: "ok"; material: LoadedSummaryMaterial }
  | { status: "not_found" }
  | { status: "not_ready" };

/**
 * Load a material's ingested text for summarization.
 *
 * `tx` must be an open tenant transaction (see `withTenantTx`): both tables are FORCE-RLS on the
 * `app.school_id` GUC, so a material or chunk belonging to another school reads as absent here —
 * the correct security posture (cross-tenant lookup is indistinguishable from nonexistence).
 *
 * A material is summarizable only once its ingest pipeline has finished (`ingest_status =
 * 'ready'`). Anything still mid-flight ('uploaded' / 'processing' / 'scanning' / 'queued') is
 * reported as {@link LoadSummaryMaterialResult.not_ready} so the client can distinguish "try
 * later" from "does not exist" (404).
 *
 * Chunks are fed as a contiguous prefix capped by `AI_SUMMARY_CHUNK_LIMIT` rows and then by
 * `AI_SUMMARY_MAX_INPUT_CHARS` of text, so the model always sees the material's opening rather
 * than a sparse sample of it. The caps bound the prompt cost the route reserves for.
 */
export async function loadSummaryMaterial(
  tx: TransactionSql,
  materialId: string,
): Promise<LoadSummaryMaterialResult> {
  const materials = await tx<{ id: string; title: string | null; ingest_status: string }[]>`
    SELECT id, title, ingest_status
    FROM app.materials
    WHERE id = ${materialId}::uuid
  `;
  const material = materials[0];
  if (!material) return { status: "not_found" };
  if (material.ingest_status !== "ready") return { status: "not_ready" };

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
    WHERE material_id = ${materialId}::uuid
    ORDER BY chunk_index ASC
    LIMIT ${AI_SUMMARY_CHUNK_LIMIT}
  `;

  let budget = AI_SUMMARY_MAX_INPUT_CHARS;
  const chunks: LoadedSummaryChunk[] = [];
  for (const row of chunkRows) {
    if (budget <= 0) break;
    const content = row.content.slice(0, budget);
    chunks.push({
      id: row.id,
      chunkIndex: row.chunk_index,
      pageNumber: row.page_number,
      sectionTitle: row.section_title,
      content,
    });
    budget -= content.length;
  }

  return { status: "ok", material: { id: material.id, title: material.title, chunks } };
}
