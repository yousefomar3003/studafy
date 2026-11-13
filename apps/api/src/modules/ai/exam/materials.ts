import type { TransactionSql } from "postgres";

/**
 * Material scope validation for exam generation (ST-171).
 *
 * Unlike `quiz/materials.ts`'s `loadQuizMaterials`, this does NOT load chunk content -- exam
 * generation is heavy and runs in the worker (`apps/workers/src/queues/exam-generation/materials.ts`
 * loads the actual chunks there), so the create route only needs the cheap existence/readiness check
 * a client should get instant feedback on, the same 404/422 posture quiz's synchronous generation
 * gives for the same two failure cases.
 */
export type ValidateExamMaterialsResult =
  | { status: "ok" }
  | { status: "not_found"; materialId: string }
  | { status: "not_ready"; materialId: string };

export async function validateExamMaterials(
  tx: TransactionSql,
  materialIds: readonly string[],
): Promise<ValidateExamMaterialsResult> {
  // One query for every requested material rather than one per id -- the failure check below
  // still walks materialIds in request order, so "first invalid material" reporting is unchanged.
  // ai_enabled: the class's AI materials setting (000196). A material of a class with it off is
  // reported not_ready, like one not yet ingested; the class lookup fails closed.
  const rows = await tx<{ id: string; ingest_status: string; ai_enabled: boolean }[]>`
    SELECT m.id, m.ingest_status,
           COALESCE(
             (SELECT cl.ai_materials_enabled FROM app.classes cl
              WHERE cl.id = m.class_id AND cl.school_id = m.school_id),
             false
           ) AS ai_enabled
    FROM app.materials m
    WHERE m.id = ANY (${materialIds}::uuid[])
  `;
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  for (const materialId of materialIds) {
    const row = rowsById.get(materialId);
    if (!row) return { status: "not_found", materialId };
    if (row.ingest_status !== "ready" || !row.ai_enabled)
      return { status: "not_ready", materialId };
  }
  return { status: "ok" };
}
