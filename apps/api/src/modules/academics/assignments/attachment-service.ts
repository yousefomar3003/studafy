import { randomUUID } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import {
  assertSchoolOwnedKey,
  buildPermanentKey,
  buildTempKey,
  readStagedSize,
} from "../../../lib/storage";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import {
  copyStagedUploads,
  discardStagedUploads,
  reserveStorage,
} from "../../storage/staged-promotion";

import { assertCanManageClass } from "./assignment-service";

import type { TxRunner } from "../../../db/tenant-tx";
import type { StorageService } from "../../../lib/storage";
import type { StagedCopy } from "../../storage/staged-promotion";
import type { UploadScanStatus } from "@studafy/constants";
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
  /** Malware scan state (000192). A download URL is minted only for a servable one. */
  scan_status: UploadScanStatus;
  created_at: Date;
}

export interface ConfirmAttachmentParams {
  storage_key: string;
  /** Omitted by the mobile app; the staged object's stored type is used instead. */
  content_type?: string;
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

const MIME_TYPE = /^[^/\s]+\/[^/\s]+$/;

/**
 * The type the staged object was uploaded with (bound into the pre-signed PUT), for a confirm that
 * did not name one. Falls back to application/octet-stream, which downloads as a plain file.
 */
async function stagedContentType(storage: StorageService, tempKey: string): Promise<string> {
  const stored = (await storage.head(tempKey))?.contentType?.trim();
  return stored && MIME_TYPE.test(stored) ? stored : "application/octet-stream";
}

/**
 * Verify a staged upload, move it under `permanent/`, and record it.
 *
 * The storage work is not transactional with the INSERT, and no transaction is held open across
 * it (../../storage/staged-promotion.ts): HEAD the staged object; one short transaction authorizes
 * and charges the quota; copy to permanent/; a second short transaction writes the row; drop the
 * staged copy. The failure modes are asymmetric and the ordering picks the harmless one: if the
 * copy succeeds and the row's transaction then fails, an unreferenced object is left in
 * `permanent/` -- wasted bytes. The reverse order would let a row exist pointing at an object that
 * was never promoted, which is a broken download the user sees.
 */
export async function confirmAttachment(
  runTx: TxRunner,
  storage: StorageService,
  schoolId: string,
  userId: string,
  assignmentId: string,
  params: ConfirmAttachmentParams,
): Promise<AttachmentRow> {
  // Untrusted on the way back in, however it was minted. This is the tenant boundary.
  const staged = assertSchoolOwnedKey(params.storage_key, schoolId, "temp");
  const copy: StagedCopy = {
    tempKey: params.storage_key,
    permanentKey: buildPermanentKey(schoolId, staged.objectId, staged.filename),
    sizeBytes: await readStagedSize(storage, params.storage_key),
  };
  const mimeType = params.content_type ?? (await stagedContentType(storage, params.storage_key));

  // The quota hard stop runs on the stored size before the copy, so a refused promotion leaves
  // the staged object untouched in temp/.
  await runTx(async (tx) => {
    await assertCanManageClass(tx, await resolveAssignmentClass(tx, schoolId, assignmentId));
    await reserveStorage(tx, copy.sizeBytes);
  });
  await copyStagedUploads(storage, runTx, [copy]);

  const row = await runTx(async (tx) => {
    await assertCanManageClass(tx, await resolveAssignmentClass(tx, schoolId, assignmentId));

    const [inserted] = await tx<AttachmentRow[]>`
      INSERT INTO app.assignment_attachments (
        school_id, assignment_id, uploaded_by_user_id,
        storage_key, original_file_name, mime_type, size_bytes, checksum_sha256
      ) VALUES (
        ${schoolId}, ${assignmentId}, ${userId},
        ${copy.permanentKey}, ${staged.filename}, ${mimeType},
        ${copy.sizeBytes}, ${params.checksum_sha256 ?? null}
      )
      RETURNING id, assignment_id, storage_key, original_file_name, mime_type,
                size_bytes, checksum_sha256, uploaded_by_user_id,
                scan_status::text AS scan_status, created_at
    `;

    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "assignment_attachments",
      targetId: inserted!.id,
      newValues: {
        assignment_id: assignmentId,
        original_file_name: inserted!.original_file_name,
        mime_type: inserted!.mime_type,
        size_bytes: inserted!.size_bytes,
      },
    });

    return inserted!;
  });
  await discardStagedUploads(storage, [copy]);
  return row;
}

/**
 * Detach a file from an assignment. Returns the stored object's key for the caller to free once
 * this transaction has committed (../../storage/free-objects.ts): deleting from S3 cannot
 * participate in the transaction, and a rollback after a successful delete would leave a row
 * pointing at bytes that no longer exist.
 */
export async function deleteAttachment(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
  attachmentId: string,
): Promise<{ storageKey: string }> {
  const classId = await resolveAssignmentClass(tx, schoolId, assignmentId);
  await assertCanManageClass(tx, classId);

  const [row] = await tx<{ id: string; original_file_name: string; storage_key: string }[]>`
    DELETE FROM app.assignment_attachments
    WHERE id = ${attachmentId}
      AND assignment_id = ${assignmentId}
      AND school_id = ${schoolId}
    RETURNING id, original_file_name, storage_key
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

  return { storageKey: row.storage_key };
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
           size_bytes, checksum_sha256, uploaded_by_user_id,
           scan_status::text AS scan_status, created_at
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
