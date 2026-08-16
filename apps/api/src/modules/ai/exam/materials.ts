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
  for (const materialId of materialIds) {
    const [material] = await tx<{ ingest_status: string }[]>`
      SELECT ingest_status
      FROM app.materials
      WHERE id = ${materialId}::uuid
    `;
    if (!material) return { status: "not_found", materialId };
    if (material.ingest_status !== "ready") return { status: "not_ready", materialId };
  }
  return { status: "ok" };
}
