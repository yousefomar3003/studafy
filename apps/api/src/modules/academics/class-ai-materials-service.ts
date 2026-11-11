/**
 * The per-class "Use this class's materials with the AI study assistant" setting (000196).
 *
 * `app.classes.ai_materials_enabled` (default true) decides whether a class's study materials may
 * reach the AI study assistant at all. While it is false:
 *
 * - nothing derived from the materials is kept: turning it off deletes the class's
 *   `app.material_chunks` rows, and with them (ON DELETE CASCADE) every quiz question, flashcard,
 *   exam item and Ask AI citation grounded on them;
 * - no new material is ingested: the scan worker marks a clean upload `ready` without queueing AI
 *   ingestion, and the ingestion worker refuses (and finishes as `ready`, chunk-free) a material
 *   whose class has the setting off, which also covers a job already queued or in flight when the
 *   setting was turned off;
 * - every AI read path (hybrid retrieval, explain, summary/concepts, quiz/flashcards, exams) treats
 *   the class's materials as unavailable, so no material text is sent to the AI provider.
 *
 * Turning it back on re-stages the class's AI-visible `ready` materials to `queued` (the same
 * staging flip a per-material re-enable does) and the route enqueues their ingestion.
 *
 * Who may change it: the route requires `material:manageAi` (teachers, the principal and the school
 * admin), and {@link assertCanManageClassAiMaterials} narrows a teacher to the classes they teach
 * through the same SECURITY DEFINER helpers RLS uses, so "teaches this class" has one definition.
 */

import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { ClassAiMaterialsSetting } from "./schemas";
import type { TransactionSql } from "postgres";

export interface SetClassAiMaterialsResult {
  setting: ClassAiMaterialsSetting;
  /** True when the stored value changed (false for a repeat of the current value). */
  changed: boolean;
  /** Materials re-staged to `queued` by turning the setting on; the route enqueues each one. */
  requeuedMaterialIds: string[];
  /** Every material of the class, for the best-effort AI cache purge after turning it off. */
  classMaterialIds: string[];
}

/** The setting for one class, or null when the class does not exist or the caller cannot see it. */
export async function getClassAiMaterialsSetting(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
): Promise<ClassAiMaterialsSetting | null> {
  const [row] = await tx<{ id: string; ai_materials_enabled: boolean }[]>`
    SELECT id, ai_materials_enabled
    FROM app.classes
    WHERE id = ${classId} AND school_id = ${schoolId}
  `;
  return row ? { class_id: row.id, enabled: row.ai_materials_enabled } : null;
}

/**
 * Refuse unless the caller leads the school (`current_user_is_school_admin`: ORG_ADMIN, PRINCIPAL,
 * SUPER_ADMIN) or teaches the class (lead teacher or a timetable slot). The permission gate already
 * ran, so the caller is staff and a 403 naming the reason serves them better than a 404.
 */
export async function assertCanManageClassAiMaterials(
  tx: TransactionSql,
  classId: string,
): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT (app.current_user_is_school_admin() OR app.teaches_class(${classId}::uuid)) AS allowed
  `;
  if (!row?.allowed) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.CLASS_AI_MATERIALS_FORBIDDEN,
      "Only this class's teachers or school leadership can change this setting.",
    );
  }
}

export async function setClassAiMaterialsSetting(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  enabled: boolean,
): Promise<SetClassAiMaterialsResult> {
  // Row lock: two concurrent toggles serialize, so an "off" can never interleave with an "on"
  // half-way through re-staging the class's materials.
  const [existing] = await tx<{ id: string; ai_materials_enabled: boolean }[]>`
    SELECT id, ai_materials_enabled
    FROM app.classes
    WHERE id = ${classId} AND school_id = ${schoolId}
    FOR UPDATE
  `;
  if (!existing) {
    throw new HTTPException(404, { message: "Class not found" });
  }

  await assertCanManageClassAiMaterials(tx, classId);

  const setting: ClassAiMaterialsSetting = { class_id: classId, enabled };
  if (existing.ai_materials_enabled === enabled) {
    return { setting, changed: false, requeuedMaterialIds: [], classMaterialIds: [] };
  }

  await tx`
    UPDATE app.classes
    SET ai_materials_enabled = ${enabled},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${classId} AND school_id = ${schoolId}
  `;

  if (enabled) {
    // Re-stage what was kept out: every AI-visible material that is `ready` (ingested before the
    // setting went off and since purged, or uploaded while it was off and never ingested). The
    // lifecycle CHECK requires 'queued' with a null ingest stamp. Every other state is left alone:
    // an in-flight pipeline still owns it, and a failed/quarantined material is never re-ingested
    // silently -- the same rule toggleAiVisible follows for one material.
    const requeued = await tx<{ id: string }[]>`
      UPDATE app.materials
      SET ingest_status = 'queued'::app.material_ingest_status,
          ingest_error = NULL,
          ingested_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}
        AND class_id = ${classId}
        AND ai_visible = true
        AND ingest_status = 'ready'::app.material_ingest_status
      RETURNING id
    `;
    const requeuedMaterialIds = requeued.map((row) => row.id);

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "classes",
      targetId: classId,
      oldValues: { ai_materials_enabled: false },
      newValues: { ai_materials_enabled: true, materials_requeued: requeuedMaterialIds.length },
    });

    return { setting, changed: true, requeuedMaterialIds, classMaterialIds: [] };
  }

  // Turning it off: delete every chunk of the class's materials. The cascade removes everything
  // grounded on them (quiz questions, flashcards, exam items, Ask AI citations), so nothing derived
  // from the materials remains. Material statuses are left as they are: a `ready` material stays
  // downloadable, and a `queued`/`processing` one is finished chunk-free by the ingestion worker,
  // which re-reads this setting under the material's row lock before it writes anything.
  const [purged] = await tx<{ count: number }[]>`
    WITH deleted AS (
      DELETE FROM app.material_chunks
      WHERE school_id = ${schoolId}
        AND material_id IN (
          SELECT id FROM app.materials WHERE school_id = ${schoolId} AND class_id = ${classId}
        )
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM deleted
  `;
  const materials = await tx<{ id: string }[]>`
    SELECT id FROM app.materials WHERE school_id = ${schoolId} AND class_id = ${classId}
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "classes",
    targetId: classId,
    oldValues: { ai_materials_enabled: true },
    newValues: { ai_materials_enabled: false, chunks_purged: purged?.count ?? 0 },
  });

  return {
    setting,
    changed: true,
    requeuedMaterialIds: [],
    classMaterialIds: materials.map((row) => row.id),
  };
}
