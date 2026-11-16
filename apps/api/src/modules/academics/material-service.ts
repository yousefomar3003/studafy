import { randomUUID } from "node:crypto";

import { ERROR_CODES, ROLES, SCHOOL_STAFF_ROLES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { callerManagesClass } from "./class-access";

import type { MaterialIngestStatus } from "./schemas";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaterialRow {
  id: string;
  school_id: string;
  class_id: string;
  uploaded_by_user_id: string;
  last_edited_by_user_id: string;
  title: string;
  description: string | null;
  storage_key: string;
  original_file_name: string;
  mime_type: string;
  // A bigint column, which postgres.js returns as a string: every query selects it as
  // `size_bytes::float8` so the response carries the number the OpenAPI contract promises.
  size_bytes: number;
  checksum_sha256: string | null;
  ai_visible: boolean;
  ingest_status: MaterialIngestStatus;
  ingest_error: string | null;
  ingested_at: Date | null;
  week_number: number | null;
  day_of_week: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListMaterialsParams {
  limit: number;
  offset: number;
  class_id?: string;
  ingest_status?: string;
  week_number?: number;
  day_of_week?: number;
}

/** What a caller may see of the material pipeline. */
export interface MaterialVisibility {
  /**
   * Only `ready` materials. Students and parents get just the files they can open: a material still
   * being uploaded, scanned or processed, or one that failed or was blocked, is the teacher's
   * business, not theirs.
   */
  readyOnly: boolean;
}

/**
 * Whether these roles see a material in every pipeline state. School staff (who upload, retry and
 * manage materials) and platform operators do; everyone else (students, parents, guests) sees only
 * `ready` materials. Row scope (role_scope_visibility) still decides which classes' materials each
 * role sees at all.
 */
export function materialVisibilityFor(roles: readonly Role[]): MaterialVisibility {
  const staff = roles.some(
    (role) => role === ROLES.SUPER_ADMIN || SCHOOL_STAFF_ROLES.includes(role),
  );
  return { readyOnly: !staff };
}

export interface InitiateUploadParams {
  class_id: string;
  title: string;
  description?: string | null;
  original_file_name: string;
  mime_type: string;
  size_bytes: number;
  checksum_sha256?: string;
  week_number?: number;
  day_of_week?: number;
}

export interface UpdateMaterialParams {
  title?: string;
  description?: string | null;
  // Validated as a pair by updateMaterialBodySchema: both omitted, both numbers, or both null.
  week_number?: number | null;
  day_of_week?: number | null;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Refuse a write to a class's materials unless the caller teaches the class or leads the school.
 *
 * Every write route is first gated by its material permission (material:create, material:update,
 * material:delete or material:manageAi), which students and parents never hold. Reading is wider
 * than writing, though: RLS lets everyone who can read the class see its materials, and that
 * includes a teacher whose own child is enrolled there. This check narrows a teacher to the
 * classes they teach. A teacher of an unrelated class cannot see the material at all and is told
 * 404 by the lookup before this runs.
 *
 * 403 rather than 404: the caller passed the permission gate, so they are staff, and "not your
 * class" serves them better than "no such material".
 */
export async function assertCanWriteClassMaterials(
  tx: TransactionSql,
  classId: string,
): Promise<void> {
  if (!(await callerManagesClass(tx, classId))) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.MATERIAL_CLASS_FORBIDDEN,
      "Only this class's teachers or the school admin can change its materials.",
    );
  }
}

/** The material a write acts on: 404 when missing or invisible, 403 when not the caller's class. */
async function getWritableMaterial(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
): Promise<MaterialRow> {
  const existing = await getMaterial(tx, schoolId, materialId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.MATERIAL_NOT_FOUND, "Material not found.");
  }
  await assertCanWriteClassMaterials(tx, existing.class_id);
  return existing;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listMaterials(
  tx: TransactionSql,
  schoolId: string,
  params: ListMaterialsParams,
  visibility: MaterialVisibility = { readyOnly: false },
): Promise<{ rows: MaterialRow[]; total: number }> {
  const classFilter = params.class_id ? tx` AND m.class_id = ${params.class_id}` : tx``;
  // Both filters apply together: a ready-only caller asking for another status gets nothing.
  const statusFilter = params.ingest_status
    ? tx` AND m.ingest_status = ${params.ingest_status}::app.material_ingest_status`
    : tx``;
  const weekFilter =
    params.week_number !== undefined ? tx` AND m.week_number = ${params.week_number}` : tx``;
  const dayFilter =
    params.day_of_week !== undefined ? tx` AND m.day_of_week = ${params.day_of_week}` : tx``;
  const visibilityFilter = visibility.readyOnly
    ? tx` AND m.ingest_status = 'ready'::app.material_ingest_status`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<MaterialRow[]>`
      SELECT m.id, m.school_id, m.class_id, m.uploaded_by_user_id, m.last_edited_by_user_id,
             m.title, m.description, m.storage_key, m.original_file_name, m.mime_type,
             m.size_bytes::float8 AS size_bytes, m.checksum_sha256, m.ai_visible, m.ingest_status, m.ingest_error,
             m.ingested_at, m.week_number, m.day_of_week, m.created_at, m.updated_at
      FROM app.materials AS m
      WHERE m.school_id = ${schoolId}
        ${classFilter}
        ${statusFilter}
        ${weekFilter}
        ${dayFilter}
        ${visibilityFilter}
      ORDER BY m.created_at DESC, m.id
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.materials AS m
      WHERE m.school_id = ${schoolId}
        ${classFilter}
        ${statusFilter}
        ${weekFilter}
        ${dayFilter}
        ${visibilityFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getMaterial(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
  visibility: MaterialVisibility = { readyOnly: false },
): Promise<MaterialRow | undefined> {
  const visibilityFilter = visibility.readyOnly
    ? tx` AND ingest_status = 'ready'::app.material_ingest_status`
    : tx``;
  const [row] = await tx<MaterialRow[]>`
    SELECT id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
           title, description, storage_key, original_file_name, mime_type,
           size_bytes::float8 AS size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
           ingested_at, week_number, day_of_week, created_at, updated_at
    FROM app.materials
    WHERE id = ${materialId} AND school_id = ${schoolId}
      ${visibilityFilter}
  `;
  return row;
}

export async function initiateUpload(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: InitiateUploadParams,
): Promise<{
  material: MaterialRow;
  upload_url: string;
  storage_key: string;
  expires_at: Date;
  /** Stored objects of the replaced failed attempts, to free once the transaction commits. */
  freedStorageKeys: string[];
}> {
  // Scope first: a teacher of another class cannot see this one, so the lookup below would tell
  // them 404 for a class that exists.
  await assertCanWriteClassMaterials(tx, params.class_id);
  const [cls] = await tx<{ id: string }[]>`
    SELECT id FROM app.classes
    WHERE id = ${params.class_id} AND school_id = ${schoolId}
  `;
  if (!cls) {
    throw new HTTPException(404, { message: "Class not found" });
  }

  // This teacher's own earlier attempt at the same file is replaced rather than left in the list:
  //
  //  - 'uploaded' with ai_visible: an attempt that never finished (the file PUT or the confirm call
  //    failed, and the app showed the teacher an error). It holds no counted bytes (the meter is
  //    credited at confirm). Any object its PUT did write is left for reconciliation and the
  //    abandoned-material sweep, which removes it once the daily recount has counted it. A row in
  //    'uploaded' with ai_visible off is kept: turning AI off used to move a confirmed material
  //    back to 'uploaded' (fixed, and repaired by 000227 where its history shows it was servable),
  //    and a row like that which 000227 could not place may still be a real material.
  //  - 'failed': the scan or the processing gave up on it. Its file was confirmed (and counted), so
  //    the caller frees it once this transaction commits (freedStorageKeys).
  const replaced = await tx<
    {
      id: string;
      ingest_status: "uploaded" | "failed";
      storage_key: string;
      thumbnail_key: string | null;
      preview_key: string | null;
    }[]
  >`
    DELETE FROM app.materials
    WHERE school_id = ${schoolId} AND class_id = ${params.class_id}
      AND original_file_name = ${params.original_file_name}
      AND uploaded_by_user_id = ${userId}
      AND (
        (ingest_status = 'uploaded' AND ai_visible)
        OR ingest_status = 'failed'
      )
    RETURNING id, ingest_status::text AS ingest_status, storage_key, thumbnail_key, preview_key
  `;
  const freedStorageKeys: string[] = [];
  for (const row of replaced) {
    await emitAuditLog(tx, {
      action: "delete",
      targetTable: "materials",
      targetId: row.id,
      oldValues: { storage_key: row.storage_key, ingest_status: row.ingest_status },
    });
    if (row.ingest_status === "failed") {
      for (const key of [row.storage_key, row.thumbnail_key, row.preview_key]) {
        if (key !== null) freedStorageKeys.push(key);
      }
    }
  }

  const [existingMaterial] = await tx<{ id: string }[]>`
    SELECT id FROM app.materials
    WHERE school_id = ${schoolId} AND class_id = ${params.class_id}
      AND original_file_name = ${params.original_file_name}
      AND ingest_status IN ('uploaded', 'processing', 'scanning')
  `;
  if (existingMaterial) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
      "An upload for this file in this class is already in progress.",
    );
  }

  // The key must be unique per upload (uq_materials_storage_key). The file name alone is not: two
  // uploads of "notes.pdf" anywhere in the school collide, and every non-Latin character becomes
  // "_", so all Arabic-named PDFs reduce to the same "_.pdf". The random prefix keeps the key
  // unique while the slug keeps it readable.
  const fileSlug = params.original_file_name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 80);
  const storageKey = `permanent/${schoolId}/materials/${randomUUID()}-${fileSlug}`;

  const [row] = await tx<MaterialRow[]>`
    INSERT INTO app.materials (
      school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
      title, description, storage_key, original_file_name, mime_type,
      size_bytes, checksum_sha256, week_number, day_of_week
    ) VALUES (
      ${schoolId},
      ${params.class_id},
      ${userId},
      ${userId},
      ${params.title},
      ${params.description ?? null},
      ${storageKey},
      ${params.original_file_name},
      ${params.mime_type},
      ${params.size_bytes},
      ${params.checksum_sha256 ?? null},
      ${params.week_number ?? null},
      ${params.day_of_week ?? null}
    )
    RETURNING id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
              title, description, storage_key, original_file_name, mime_type,
              size_bytes::float8 AS size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
              ingested_at, week_number, day_of_week, created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "materials",
    targetId: row!.id,
    newValues: {
      title: params.title,
      class_id: params.class_id,
      storage_key: storageKey,
      week_number: params.week_number ?? null,
      day_of_week: params.day_of_week ?? null,
    },
  });

  return {
    material: row!,
    upload_url: "",
    storage_key: storageKey,
    expires_at: new Date(),
    freedStorageKeys,
  };
}

export async function confirmUpload(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
  storageKey: string,
  checksumSha256?: string,
): Promise<MaterialRow> {
  const existing = await getWritableMaterial(tx, schoolId, materialId);

  if (existing.storage_key !== storageKey) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Storage key does not match the material record.",
    );
  }

  if (existing.ingest_status !== "uploaded") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.MATERIAL_INGEST_IN_PROGRESS,
      `Material is already in ${existing.ingest_status} state.`,
    );
  }

  if (checksumSha256 && existing.checksum_sha256 && checksumSha256 !== existing.checksum_sha256) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.MATERIAL_STORAGE_CONFIRM_FAILED,
      "Client checksum does not match the stored checksum.",
    );
  }

  const [row] = await tx<MaterialRow[]>`
    UPDATE app.materials
    SET ingest_status = 'scanning'::app.material_ingest_status,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${materialId} AND school_id = ${schoolId}
    RETURNING id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
              title, description, storage_key, original_file_name, mime_type,
              size_bytes::float8 AS size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
              ingested_at, week_number, day_of_week, created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "materials",
    targetId: materialId,
    oldValues: { ingest_status: existing.ingest_status },
    newValues: { ingest_status: "scanning" },
  });

  return row!;
}

/**
 * The material a retry would re-run, or a refusal: only a `failed` material can be retried. A
 * quarantined one was infected and must never be re-run; one still in the pipeline needs no retry.
 */
export async function getRetryableMaterial(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
): Promise<MaterialRow> {
  const existing = await getWritableMaterial(tx, schoolId, materialId);
  if (existing.ingest_status !== "failed") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `Only a failed material can be retried; this one is ${existing.ingest_status}.`,
    );
  }
  return existing;
}

/**
 * Send a failed material back through the pipeline: 'failed' -> 'scanning', the same state confirm
 * leaves it in, so the caller enqueues the same scan job. Guarded by the status, so two retries at
 * once flip it only once; the loser is refused.
 */
export async function retryFailedMaterial(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
): Promise<MaterialRow> {
  const [row] = await tx<(MaterialRow & { previous_error: string | null })[]>`
    UPDATE app.materials AS m
    SET ingest_status = 'scanning'::app.material_ingest_status,
        ingest_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    FROM (
      SELECT id, ingest_error FROM app.materials
      WHERE id = ${materialId} AND school_id = ${schoolId}
    ) AS before
    WHERE m.id = before.id AND m.school_id = ${schoolId}
      AND m.ingest_status = 'failed'::app.material_ingest_status
    RETURNING m.id, m.school_id, m.class_id, m.uploaded_by_user_id, m.last_edited_by_user_id,
              m.title, m.description, m.storage_key, m.original_file_name, m.mime_type,
              m.size_bytes::float8 AS size_bytes, m.checksum_sha256, m.ai_visible, m.ingest_status,
              m.ingest_error, m.ingested_at, m.week_number, m.day_of_week, m.created_at,
              m.updated_at, before.ingest_error AS previous_error
  `;
  if (!row) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Only a failed material can be retried.",
    );
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "materials",
    targetId: materialId,
    oldValues: { ingest_status: "failed", ingest_error: row.previous_error },
    newValues: { ingest_status: "scanning", retried: true },
  });

  const { previous_error: _previous, ...material } = row;
  return material;
}

export async function updateMaterial(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
  userId: string,
  params: UpdateMaterialParams,
): Promise<MaterialRow> {
  const existing = await getWritableMaterial(tx, schoolId, materialId);

  // Omitted keeps the current placement; the schema only lets the pair through together.
  const placement =
    params.week_number !== undefined && params.day_of_week !== undefined
      ? { week_number: params.week_number, day_of_week: params.day_of_week }
      : { week_number: existing.week_number, day_of_week: existing.day_of_week };

  const [row] = await tx<MaterialRow[]>`
    UPDATE app.materials
    SET title = COALESCE(${params.title ?? null}, title),
        description = ${params.description !== undefined ? params.description : existing.description},
        week_number = ${placement.week_number},
        day_of_week = ${placement.day_of_week},
        last_edited_by_user_id = ${userId},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${materialId} AND school_id = ${schoolId}
    RETURNING id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
              title, description, storage_key, original_file_name, mime_type,
              size_bytes::float8 AS size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
              ingested_at, week_number, day_of_week, created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "materials",
    targetId: materialId,
    oldValues: {
      title: existing.title,
      description: existing.description,
      week_number: existing.week_number,
      day_of_week: existing.day_of_week,
    },
    newValues: {
      title: params.title,
      description: params.description,
      week_number: params.week_number,
      day_of_week: params.day_of_week,
    },
  });

  return row!;
}

/**
 * Delete a material. Returns the stored objects it pointed at -- the file and its derived
 * thumbnail and preview -- for the caller to free once the transaction has committed
 * (../storage/free-objects.ts).
 */
export async function deleteMaterial(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
): Promise<{ deleted: boolean; storageKeys: string[] }> {
  const existing = await getWritableMaterial(tx, schoolId, materialId);

  const [removed] = await tx<
    { storage_key: string; thumbnail_key: string | null; preview_key: string | null }[]
  >`
    DELETE FROM app.materials
    WHERE id = ${materialId} AND school_id = ${schoolId}
    RETURNING storage_key, thumbnail_key, preview_key
  `;

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "materials",
    targetId: materialId,
    oldValues: { storage_key: existing.storage_key },
  });

  const storageKeys = removed
    ? [removed.storage_key, removed.thumbnail_key, removed.preview_key].filter(
        (key): key is string => key !== null,
      )
    : [];
  return { deleted: true, storageKeys };
}

export interface ToggleAiVisibleResult {
  material: MaterialRow;
  /**
   * True when turning AI off finished a material that was waiting for, or in the middle of, AI
   * ingestion. The ingestion worker would have queued its thumbnail and preview once it was done,
   * so the caller queues them instead.
   */
  derivePreviews: boolean;
}

/**
 * Toggle ai_visible on a material.
 *
 * AI visibility decides only whether the material's text is chunked for the AI study assistant. It
 * never decides whether the material can be opened: that is `ready`, set once the malware scan is
 * clean (and, for an AI-visible material, ingestion has finished).
 *
 * Disabling deletes the material's chunks (and with them, ON DELETE CASCADE, anything grounded on
 * them) and leaves the material servable:
 *  - `ready` stays `ready`, its ingest stamp kept;
 *  - `queued` or `processing` (clean, waiting for or in AI ingestion) becomes `ready` now, since
 *    there is nothing left to wait for. The ingestion worker's claim and final re-claim both skip a
 *    material that is no longer AI-visible or no longer `queued`/`processing`, so an in-flight job
 *    writes no chunks and never downgrades it;
 *  - every other state is left alone: `uploaded` still waits for its confirm, `scanning` for the
 *    scan (whose clean verdict sends a non-AI material straight to `ready`), and `failed` /
 *    `quarantined` keep their verdict and error.
 *
 * Enabling stages a `ready` material for re-ingestion: it is flipped to 'queued' (the ST-161
 * re-ingest / re-enable staging state) and the route enqueues an ai-ingestion job, which drives it
 * through parse -> chunk -> embed to 'ready' again. For any other state the status is left alone —
 * an in-flight pipeline ('uploaded' -> confirm, 'scanning' -> scan, 'processing' -> claim) still
 * owns it, and a 'failed'/'quarantined' material must be re-uploaded rather than silently
 * re-ingested (a failed scan must never be bypassed into ingestion).
 */
export async function toggleAiVisible(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
  aiVisible: boolean,
): Promise<ToggleAiVisibleResult> {
  const existing = await getWritableMaterial(tx, schoolId, materialId);

  if (existing.ai_visible === aiVisible) {
    return { material: existing, derivePreviews: false };
  }

  if (aiVisible) {
    // A class whose AI materials setting is off (000196) keeps its materials out of ingestion: the
    // flag is recorded, but a 'ready' material is not re-staged until the class setting is turned
    // back on (which re-stages every AI-visible 'ready' material of the class). Fail closed when
    // the class cannot be read.
    const [cls] = await tx<{ ai_materials_enabled: boolean }[]>`
      SELECT ai_materials_enabled
      FROM app.classes
      WHERE id = ${existing.class_id} AND school_id = ${schoolId}
    `;
    const restage = cls?.ai_materials_enabled === true;

    // 'ready' -> 'queued' + clear the ingest stamp (the CHECK requires 'queued' with a null stamp);
    // every other state keeps its status, so nothing mid-flight is derailed.
    const [row] = await tx<MaterialRow[]>`
      UPDATE app.materials
      SET ai_visible = true,
          ingest_status = CASE
            WHEN ${restage}::boolean AND ingest_status = 'ready'::app.material_ingest_status
              THEN 'queued'::app.material_ingest_status
            ELSE ingest_status
          END,
          ingest_error = CASE
            WHEN ${restage}::boolean AND ingest_status = 'ready'::app.material_ingest_status THEN NULL
            ELSE ingest_error
          END,
          ingested_at = CASE
            WHEN ${restage}::boolean AND ingest_status = 'ready'::app.material_ingest_status THEN NULL
            ELSE ingested_at
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${materialId} AND school_id = ${schoolId}
      RETURNING id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
                title, description, storage_key, original_file_name, mime_type,
                size_bytes::float8 AS size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
                ingested_at, week_number, day_of_week, created_at, updated_at
    `;
    if (!row) throw new HTTPException(404, { message: "Material not found" });

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "materials",
      targetId: materialId,
      oldValues: { ai_visible: false },
      newValues: { ai_visible: true, ingest_status: row.ingest_status },
    });

    return { material: row, derivePreviews: false };
  }

  // Disabling. The row is updated first: that takes its lock, so an ingestion job finishing at this
  // moment either commits its chunks before (and the delete below sees them) or re-claims after
  // (sees ai_visible off and writes none). Deleting the chunks first could miss a job's commit.
  //
  // A clean material waiting for, or in, AI ingestion has nothing left to wait for: it is ready
  // now. The lifecycle CHECK requires 'ready' with no error and an ingest stamp; a material
  // already 'ready' keeps the stamp it has.
  const finishes = existing.ingest_status === "queued" || existing.ingest_status === "processing";
  const [row] = await tx<MaterialRow[]>`
    UPDATE app.materials
    SET ai_visible = false,
        ingest_status = CASE
          WHEN ingest_status IN ('queued', 'processing') THEN 'ready'::app.material_ingest_status
          ELSE ingest_status
        END,
        ingested_at = CASE
          WHEN ingest_status IN ('queued', 'processing') THEN CURRENT_TIMESTAMP
          ELSE ingested_at
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${materialId} AND school_id = ${schoolId}
    RETURNING id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
              title, description, storage_key, original_file_name, mime_type,
              size_bytes::float8 AS size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
              ingested_at, week_number, day_of_week, created_at, updated_at
  `;
  if (!row) throw new HTTPException(404, { message: "Material not found" });

  // Deleted explicitly (not left to a later cascade) so the purge is visible and auditable.
  const deleted = await tx`
    DELETE FROM app.material_chunks
    WHERE material_id = ${materialId} AND school_id = ${schoolId}
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "materials",
    targetId: materialId,
    oldValues: { ai_visible: true, ingest_status: existing.ingest_status },
    newValues: {
      ai_visible: false,
      ingest_status: row.ingest_status,
      chunks_purged: deleted.count,
    },
  });

  return { material: row, derivePreviews: finishes && row.ingest_status === "ready" };
}
