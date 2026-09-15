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
  const rows = await tx<{ id: string; ingest_status: string }[]>`
    SELECT id, ingest_status
    FROM app.materials
    WHERE id = ANY (${materialIds}::uuid[])
  `;
  const statusById = new Map(rows.map((row) => [row.id, row.ingest_status]));

  for (const materialId of materialIds) {
    const status = statusById.get(materialId);
    if (!status) return { status: "not_found", materialId };
    if (status !== "ready") return { status: "not_ready", materialId };
  }
  return { status: "ok" };
}
