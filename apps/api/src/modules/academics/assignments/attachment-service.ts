import { randomUUID } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import {
  assertSchoolOwnedKey,
  buildPermanentKey,
  buildTempKey,
  promoteTempObject,
} from "../../../lib/storage";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { assertStorageUploadQuota, recordStorageUpload } from "../../storage/quota-service";

import { assertCanManageClass } from "./assignment-service";

import type { StorageService } from "../../../lib/storage";
import type { TransactionSql } from "postgres";

/**
 * Assignment file attachments (ST-103).
 *
 * ## The upload is three steps, and it has to be
 *
 *   1. POST .../attachments/upload-url  -> a pre-signed PUT for `temp/<schoolId>/<uuid>/<name>`
 *   2. the client PUTs the bytes straight to object storage
 *   3. POST .../attachments             -> this service verifies, promotes to `permanent/`, persists
 *
 * The file never passes through this API. That is the point: routing tens of megabytes of PDF
 * through a request handler to re-upload it costs double the bandwidth and holds a worker for the
 * duration of a phone's upload.
 *
 * Step 3 is not a formality. Without a server-side existence check a client could confirm metadata
 * for a key it never wrote, leaving a row that renders as a permanently broken download.
 *
 * ## Why the key is re-validated on the way back in
 *
 * The storage key is handed to the client in step 1 and handed back in step 3, which makes it
 * untrusted input on its return leg no matter that we minted it. assertSchoolOwnedKey re-derives
 * that it is a `temp/` key belonging to THIS school before anything touches storage. A caller who
 * substitutes another school's key gets a 403 rather than a cross-tenant copy.
 */

export interface AttachmentRow {
  id: string;
  assignment_id: string;
  storage_key: string;
  original_file_name: string;
  mime_type: string;
  /** bigint, which postgres.js hands back as a string rather than risk a lossy Number. */
  size_bytes: string;
  checksum_sha256: string | null;
  uploaded_by_user_id: string;
  created_at: Date;
}

export interface ConfirmAttachmentParams {
  storage_key: string;
  content_type: string;
  checksum_sha256?: string;
}

/**
 * Resolve the class an assignment belongs to, for scope checks.
 *
 * Separate from the assignment service's readers because attachment mutations need the class id
 * and nothing else, and going through getAssignment would apply the student-facing visibility
 * predicate -- which correctly hides a draft from students, and would therefore hide a teacher's
 * own draft from the code that lets them attach a file to it.
 */
async function resolveAssignmentClass(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
): Promise<string> {
  const [row] = await tx<{ class_id: string }[]>`
    SELECT class_id FROM app.assignments
    WHERE id = ${assignmentId} AND school_id = ${schoolId}
  `;

  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Assignment not found");
  }

  return row.class_id;
}

/**
 * Mint a pre-signed PUT URL for a staged upload.
 *
 * The object id is server-generated, never client-supplied: it is what keeps two teachers
 * uploading `notes.pdf` to the same assignment from colliding, and what stops a caller from
 * choosing a key that overwrites an existing attachment.
 *
 * Nothing is persisted here. An abandoned upload leaves only an object under `temp/`, which the
 * bucket's 24h lifecycle rule reclaims on its own -- that rule is the cleanup mechanism, not a
 * backstop for one.
 */
export async function createUploadUrl(
  tx: TransactionSql,
  storage: StorageService,
  schoolId: string,
  assignmentId: string,
  params: { file_name: string; content_type: string },
): Promise<{ upload_url: string; storage_key: string; expires_at: Date }> {
  const classId = await resolveAssignmentClass(tx, schoolId, assignmentId);
  await assertCanManageClass(tx, classId);

  const storageKey = buildTempKey(schoolId, randomUUID(), params.file_name);
  const presigned = await storage.presign(storageKey, "PUT", params.content_type);

  return {
    upload_url: presigned.url,
    storage_key: storageKey,
    expires_at: presigned.expiresAt,
  };
}

/**
 * Verify a staged upload, move it under `permanent/`, and record it.
 *
 * The storage work happens before the INSERT and is not transactional with it. That ordering is
 * deliberate and the failure modes are asymmetric: if the copy succeeds and the transaction then
 * rolls back, an unreferenced object is left in `permanent/` -- wasted bytes, reclaimable by a
 * sweep. The reverse order would let a row exist pointing at an object that was never promoted,
 * which is a broken download the user sees.
 */
export async function confirmAttachment(
  tx: TransactionSql,
  storage: StorageService,
  schoolId: string,
  userId: string,
  assignmentId: string,
  params: ConfirmAttachmentParams,
): Promise<AttachmentRow> {
  const classId = await resolveAssignmentClass(tx, schoolId, assignmentId);
  await assertCanManageClass(tx, classId);

  // Untrusted on the way back in, however it was minted. This is the tenant boundary.
  const staged = assertSchoolOwnedKey(params.storage_key, schoolId, "temp");
  const permanentKey = buildPermanentKey(schoolId, staged.objectId, staged.filename);

  // The quota hard stop runs on the stored size before the copy, so a refused promotion leaves
  // the staged object untouched in temp/; the meter is credited once the promotion actually lands.
  const promoted = await promoteTempObject(storage, params.storage_key, permanentKey, {
    onSize: async (sizeBytes) => {
      await assertStorageUploadQuota(tx, sizeBytes);
    },
  });
  await recordStorageUpload(tx, promoted.sizeBytes);

  const [row] = await tx<AttachmentRow[]>`
    INSERT INTO app.assignment_attachments (
      school_id, assignment_id, uploaded_by_user_id,
      storage_key, original_file_name, mime_type, size_bytes, checksum_sha256
    ) VALUES (
      ${schoolId}, ${assignmentId}, ${userId},
      ${permanentKey}, ${staged.filename}, ${params.content_type},
      ${promoted.sizeBytes}, ${params.checksum_sha256 ?? null}
    )
    RETURNING id, assignment_id, storage_key, original_file_name, mime_type,
              size_bytes, checksum_sha256, uploaded_by_user_id, created_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "assignment_attachments",
    targetId: row!.id,
    newValues: {
      assignment_id: assignmentId,
      original_file_name: row!.original_file_name,
      mime_type: row!.mime_type,
      size_bytes: row!.size_bytes,
    },
  });

  return row!;
}

/**
 * Detach a file from an assignment.
 *
 * The database row goes; the stored object stays. Deleting from S3 cannot participate in the
 * transaction, so a rollback after a successful delete would leave a row pointing at bytes that no
 * longer exist -- strictly worse than an orphaned object, which costs storage and nothing else.
 */
export async function deleteAttachment(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
  attachmentId: string,
): Promise<void> {
  const classId = await resolveAssignmentClass(tx, schoolId, assignmentId);
  await assertCanManageClass(tx, classId);

  const [row] = await tx<{ id: string; original_file_name: string }[]>`
    DELETE FROM app.assignment_attachments
    WHERE id = ${attachmentId}
      AND assignment_id = ${assignmentId}
      AND school_id = ${schoolId}
    RETURNING id, original_file_name
  `;

  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Attachment not found");
  }

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "assignment_attachments",
    targetId: row.id,
    oldValues: { assignment_id: assignmentId, original_file_name: row.original_file_name },
  });
}

/**
 * Load attachments for a page of assignments in one query.
 *
 * Batched rather than per-assignment because the list endpoint hydrates up to 100 assignments at
 * once, and a per-row lookup would turn one page into 101 round trips. Returns a Map keyed by
 * assignment id so the caller can attach them without a nested scan.
 */
export async function listAttachmentsByAssignment(
  tx: TransactionSql,
  schoolId: string,
  assignmentIds: readonly string[],
): Promise<Map<string, AttachmentRow[]>> {
  const grouped = new Map<string, AttachmentRow[]>();
  if (assignmentIds.length === 0) return grouped;

  const rows = await tx<AttachmentRow[]>`
    SELECT id, assignment_id, storage_key, original_file_name, mime_type,
           size_bytes, checksum_sha256, uploaded_by_user_id, created_at
    FROM app.assignment_attachments
    WHERE school_id = ${schoolId}
      AND assignment_id IN ${tx(assignmentIds as string[])}
    ORDER BY created_at ASC, id ASC
  `;

  for (const row of rows) {
    const existing = grouped.get(row.assignment_id);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.assignment_id, [row]);
    }
  }

  return grouped;
}
