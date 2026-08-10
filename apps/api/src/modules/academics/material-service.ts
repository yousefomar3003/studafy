import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { MaterialIngestStatus } from "./schemas";
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
  size_bytes: number;
  checksum_sha256: string | null;
  ai_visible: boolean;
  ingest_status: MaterialIngestStatus;
  ingest_error: string | null;
  ingested_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListMaterialsParams {
  limit: number;
  offset: number;
  class_id?: string;
  ingest_status?: string;
}

export interface InitiateUploadParams {
  class_id: string;
  title: string;
  description?: string | null;
  original_file_name: string;
  mime_type: string;
  size_bytes: number;
  checksum_sha256?: string;
}

export interface UpdateMaterialParams {
  title?: string;
  description?: string | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listMaterials(
  tx: TransactionSql,
  schoolId: string,
  params: ListMaterialsParams,
): Promise<{ rows: MaterialRow[]; total: number }> {
  const classFilter = params.class_id ? tx` AND m.class_id = ${params.class_id}` : tx``;
  const statusFilter = params.ingest_status
    ? tx` AND m.ingest_status = ${params.ingest_status}::app.material_ingest_status`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<MaterialRow[]>`
      SELECT m.id, m.school_id, m.class_id, m.uploaded_by_user_id, m.last_edited_by_user_id,
             m.title, m.description, m.storage_key, m.original_file_name, m.mime_type,
             m.size_bytes, m.checksum_sha256, m.ai_visible, m.ingest_status, m.ingest_error,
             m.ingested_at, m.created_at, m.updated_at
      FROM app.materials AS m
      WHERE m.school_id = ${schoolId}
        ${classFilter}
        ${statusFilter}
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
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getMaterial(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
): Promise<MaterialRow | undefined> {
  const [row] = await tx<MaterialRow[]>`
    SELECT id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
           title, description, storage_key, original_file_name, mime_type,
           size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
           ingested_at, created_at, updated_at
    FROM app.materials
    WHERE id = ${materialId} AND school_id = ${schoolId}
  `;
  return row;
}

export async function initiateUpload(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: InitiateUploadParams,
): Promise<{ material: MaterialRow; upload_url: string; storage_key: string; expires_at: Date }> {
  const [cls] = await tx<{ id: string }[]>`
    SELECT id FROM app.classes
    WHERE id = ${params.class_id} AND school_id = ${schoolId}
  `;
  if (!cls) {
    throw new HTTPException(404, { message: "Class not found" });
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

  const fileSlug = params.original_file_name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 80);
  const storageKey = `permanent/${schoolId}/materials/${fileSlug}`;

  const [row] = await tx<MaterialRow[]>`
    INSERT INTO app.materials (
      school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
      title, description, storage_key, original_file_name, mime_type,
      size_bytes, checksum_sha256
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
      ${params.checksum_sha256 ?? null}
    )
    RETURNING id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
              title, description, storage_key, original_file_name, mime_type,
              size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
              ingested_at, created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "materials",
    targetId: row!.id,
    newValues: { title: params.title, class_id: params.class_id, storage_key: storageKey },
  });

  return { material: row!, upload_url: "", storage_key: storageKey, expires_at: new Date() };
}

export async function confirmUpload(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
  storageKey: string,
  checksumSha256?: string,
): Promise<MaterialRow> {
  const existing = await getMaterial(tx, schoolId, materialId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.MATERIAL_NOT_FOUND, "Material not found.");
  }

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
              size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
              ingested_at, created_at, updated_at
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

export async function updateMaterial(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
  userId: string,
  params: UpdateMaterialParams,
): Promise<MaterialRow> {
  const existing = await getMaterial(tx, schoolId, materialId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.MATERIAL_NOT_FOUND, "Material not found.");
  }

  const [row] = await tx<MaterialRow[]>`
    UPDATE app.materials
    SET title = COALESCE(${params.title ?? null}, title),
        description = ${params.description !== undefined ? params.description : existing.description},
        last_edited_by_user_id = ${userId},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${materialId} AND school_id = ${schoolId}
    RETURNING id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
              title, description, storage_key, original_file_name, mime_type,
              size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
              ingested_at, created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "materials",
    targetId: materialId,
    oldValues: { title: existing.title, description: existing.description },
    newValues: { title: params.title, description: params.description },
  });

  return row!;
}

export async function deleteMaterial(
  tx: TransactionSql,
  schoolId: string,
  materialId: string,
): Promise<{ deleted: boolean }> {
  const existing = await getMaterial(tx, schoolId, materialId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.MATERIAL_NOT_FOUND, "Material not found.");
  }

  await tx`
    DELETE FROM app.materials
    WHERE id = ${materialId} AND school_id = ${schoolId}
  `;

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "materials",
    targetId: materialId,
    oldValues: { storage_key: existing.storage_key },
  });

  return { deleted: true };
}

/**
 * Toggle ai_visible on a material.
 *
 * Disabling purges all material_chunks (ON DELETE CASCADE handles this at the schema level) and
 * resets ingest_status to 'uploaded' so a future enable triggers re-ingestion.
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
): Promise<MaterialRow> {
  const existing = await getMaterial(tx, schoolId, materialId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.MATERIAL_NOT_FOUND, "Material not found.");
  }

  if (existing.ai_visible === aiVisible) {
    return existing;
  }

  if (aiVisible) {
    // 'ready' -> 'queued' + clear the ingest stamp (the CHECK requires 'queued' with a null stamp);
    // every other state keeps its status, so nothing mid-flight is derailed.
    const [row] = await tx<MaterialRow[]>`
      UPDATE app.materials
      SET ai_visible = true,
          ingest_status = CASE
            WHEN ingest_status = 'ready'::app.material_ingest_status
              THEN 'queued'::app.material_ingest_status
            ELSE ingest_status
          END,
          ingest_error = CASE
            WHEN ingest_status = 'ready'::app.material_ingest_status THEN NULL
            ELSE ingest_error
          END,
          ingested_at = CASE
            WHEN ingest_status = 'ready'::app.material_ingest_status THEN NULL
            ELSE ingested_at
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${materialId} AND school_id = ${schoolId}
      RETURNING id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
                title, description, storage_key, original_file_name, mime_type,
                size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
                ingested_at, created_at, updated_at
    `;
    if (!row) throw new HTTPException(404, { message: "Material not found" });

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "materials",
      targetId: materialId,
      oldValues: { ai_visible: false },
      newValues: { ai_visible: true, ingest_status: row.ingest_status },
    });

    return row;
  }

  // Disabling: reset flags so a future enable starts fresh.
  // Chunks are purged by ON DELETE CASCADE if the material is deleted, but here we
  // explicitly delete them so the purge is visible and auditable.
  const deleted = await tx<{ count: string }[]>`
    DELETE FROM app.material_chunks
    WHERE material_id = ${materialId} AND school_id = ${schoolId}
  `;

  const [row] = await tx<MaterialRow[]>`
    UPDATE app.materials
    SET ai_visible = false,
        ingest_status = 'uploaded'::app.material_ingest_status,
        ingest_error = NULL,
        ingested_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${materialId} AND school_id = ${schoolId}
    RETURNING id, school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
              title, description, storage_key, original_file_name, mime_type,
              size_bytes, checksum_sha256, ai_visible, ingest_status, ingest_error,
              ingested_at, created_at, updated_at
  `;
  if (!row) throw new HTTPException(404, { message: "Material not found" });

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "materials",
    targetId: materialId,
    oldValues: { ai_visible: true, ingest_status: existing.ingest_status },
    newValues: {
      ai_visible: false,
      ingest_status: "uploaded",
      chunks_purged: Number(deleted[0]?.count ?? 0),
    },
  });

  return row;
}
