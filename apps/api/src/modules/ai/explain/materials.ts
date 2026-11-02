import { AI_EXPLAIN_MAX_INPUT_CHARS } from "../config";

import type { TransactionSql } from "postgres";

/** The single retrieved passage the explanation will rewrite, plus its citation anchors. */
export interface LoadedExplainChunk {
  id: string;
  content: string;
  materialId: string;
  materialTitle: string | null;
  pageNumber: number | null;
  sectionTitle: string | null;
}

export type LoadExplainPassageResult =
  { status: "ok"; chunk: LoadedExplainChunk } | { status: "not_found" } | { status: "not_ready" };

/**
 * Load one retrieved passage (`app.material_chunks` row) for the explain endpoint.
 *
 * `tx` must be an open tenant transaction (see `withTenantTx`): both tables are FORCE-RLS on the
 * `app.school_id` GUC, so a chunk belonging to another school reads as absent here — the correct
 * security posture (a cross-tenant lookup is indistinguishable from nonexistence). The join to
 * `app.materials` is tenant-composite, the same discipline hybrid retrieval uses, so the citation
 * anchors can never cross schools even if a join predicate were ever relaxed.
 *
 * A chunk is explainable only once its ingest pipeline has finished (`ingest_status = 'ready'`).
 * Anything still mid-flight ('uploaded' / 'processing' / 'scanning' / 'queued') is reported as
 * {@link LoadExplainPassageResult.not_ready} so the client can distinguish "try later" from "does
 * not exist" (404).
 *
 * The loaded text is capped at `AI_EXPLAIN_MAX_INPUT_CHARS`, bounding the prompt cost the route
 * reserves for. A single chunk already sits below that cap (the ingest chunker's 800-token budget
 * is ~3,200 chars), so the cap only guards against an oversized row.
 */
export async function loadExplainPassage(
  tx: TransactionSql,
  chunkId: string,
): Promise<LoadExplainPassageResult> {
  const rows = await tx<
    {
      chunk_id: string;
      content: string;
      material_id: string;
      material_title: string | null;
      page_number: number | null;
      section_title: string | null;
      ingest_status: string;
    }[]
  >`
    SELECT c.id AS chunk_id,
           c.content,
           c.material_id,
           m.title AS material_title,
           c.page_number,
           c.section_title,
           m.ingest_status
    FROM app.material_chunks c
    JOIN app.materials m ON m.id = c.material_id AND m.school_id = c.school_id
    WHERE c.id = ${chunkId}::uuid
  `;
  const row = rows[0];
  if (!row) return { status: "not_found" };
  if (row.ingest_status !== "ready") return { status: "not_ready" };

  return {
    status: "ok",
    chunk: {
      id: row.chunk_id,
      content: row.content.slice(0, AI_EXPLAIN_MAX_INPUT_CHARS),
      materialId: row.material_id,
      materialTitle: row.material_title,
      pageNumber: row.page_number,
      sectionTitle: row.section_title,
    },
  };
}
