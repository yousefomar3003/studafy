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

import { resolveCallerStudentId, resolveSubmissionForAttachment } from "./submission-service";

import type { StorageService } from "../../../lib/storage";
import type { TransactionSql } from "postgres";

/**
 * Submission file attachments (ST-104).
 *
 * Structurally identical to the assignment attachment service, and deliberately so -- same
 * three-step upload, same key re-validation, same ordering of storage work against the INSERT. The
 * reasoning for each of those is set out at length in
 * modules/academics/assignments/attachment-service.ts and is not repeated here. What follows is
 * only what differs.
 *
 * ## What differs: who may attach
 *
 * An assignment attachment is the teacher's material, so that service gates on
 * `assertCanManageClass`. A submission attachment is the STUDENT'S WORK, so this one gates on
 * ownership: only the student the submission belongs to may add or remove a file. A teacher of the
 * class can read these attachments -- app.can_read_submission (000049) grants that, and they must
 * be able to open what they are marking -- but they cannot alter the evidence. The route layer
 * enforces the same thing from the other side by gating on submission:update, which
 * INSTRUCTOR and TEACHING_ASSISTANT do not hold.
 *
 * ## What differs: attempt_number
 *
 * Resubmission updates the submission row in place rather than inserting a new one, so files would
 * otherwise pile up across attempts with no way to tell which version a given file belonged to.
 * Every row is stamped with the submission's attempt_number as it stood when the file was
 * confirmed.
 */

export interface SubmissionAttachmentRow {
  id: string;
  submission_id: string;
  storage_key: string;
  original_file_name: string;
  mime_type: string;
  /** bigint, which postgres.js hands back as a string rather than risk a lossy Number. */
  size_bytes: string;
  checksum_sha256: string | null;
  attempt_number: number;
  uploaded_by_user_id: string;
  created_at: Date;
}

export interface ConfirmSubmissionAttachmentParams {
  storage_key: string;
  content_type: string;
  checksum_sha256?: string;
}

/**
 * Refuse unless the caller is the student whose work this is.
 *
 * 403 rather than 404 for a submission that exists but belongs to someone else: the caller holds
 * submission:update, so they are a student in this school, and the only id they could be probing
 * with is one they got from somewhere they should not have. Note that a student cannot enumerate
 * ids to begin with -- role_scope_visibility (000037) hides other students' rows entirely, so
 * resolveSubmissionForAttachment answers 404 first for anything they were never shown.
 */
async function assertOwnsSubmission(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
): Promise<{ studentId: string; attemptNumber: number }> {
  const submission = await resolveSubmissionForAttachment(tx, schoolId, submissionId);
  const callerStudentId = await resolveCallerStudentId(tx, schoolId);

  if (!callerStudentId || callerStudentId !== submission.student_id) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.SUBMISSION_FORBIDDEN,
      "You can only attach files to your own submission",
    );
  }

  return { studentId: callerStudentId, attemptNumber: submission.attempt_number };
}

/**
 * Mint a pre-signed PUT URL for a staged upload.
 *
 * The object id is server-generated, never client-supplied: it is what keeps two students
 * uploading `essay.pdf` from colliding, and what stops a caller choosing a key that overwrites an
 * existing attachment -- including somebody else's.
 *
 * Nothing is persisted here. An abandoned upload leaves only an object under `temp/`, which the
 * bucket's 24h lifecycle rule reclaims on its own.
 */
export async function createSubmissionUploadUrl(
  tx: TransactionSql,
  storage: StorageService,
  schoolId: string,
  submissionId: string,
  params: { file_name: string; content_type: string },
): Promise<{ upload_url: string; storage_key: string; expires_at: Date }> {
  await assertOwnsSubmission(tx, schoolId, submissionId);

  const storageKey = buildTempKey(schoolId, randomUUID(), params.file_name);
  const presigned = storage.presign(storageKey, "PUT", params.content_type);

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
 * which is a broken download the student sees on work they believe they handed in.
 */
export async function confirmSubmissionAttachment(
  tx: TransactionSql,
  storage: StorageService,
  schoolId: string,
  userId: string,
  submissionId: string,
  params: ConfirmSubmissionAttachmentParams,
): Promise<SubmissionAttachmentRow> {
  const { attemptNumber } = await assertOwnsSubmission(tx, schoolId, submissionId);

  // Untrusted on the way back in, however it was minted. This is the tenant boundary.
  const staged = assertSchoolOwnedKey(params.storage_key, schoolId, "temp");
  const permanentKey = buildPermanentKey(schoolId, staged.objectId, staged.filename);

  const promoted = await promoteTempObject(storage, params.storage_key, permanentKey);

  const [row] = await tx<SubmissionAttachmentRow[]>`
    INSERT INTO app.submission_attachments (
      school_id, submission_id, uploaded_by_user_id,
      storage_key, original_file_name, mime_type, size_bytes, checksum_sha256, attempt_number
    ) VALUES (
      ${schoolId}, ${submissionId}, ${userId},
      ${permanentKey}, ${staged.filename}, ${params.content_type},
      ${promoted.sizeBytes}, ${params.checksum_sha256 ?? null}, ${attemptNumber}
    )
    RETURNING id, submission_id, storage_key, original_file_name, mime_type,
              size_bytes, checksum_sha256, attempt_number, uploaded_by_user_id, created_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "submission_attachments",
    targetId: row!.id,
    newValues: {
      submission_id: submissionId,
      original_file_name: row!.original_file_name,
      mime_type: row!.mime_type,
      size_bytes: row!.size_bytes,
      attempt_number: row!.attempt_number,
    },
  });

  return row!;
}

/**
 * Detach a file from a submission.
 *
 * The database row goes; the stored object stays. Deleting from S3 cannot participate in the
 * transaction, so a rollback after a successful delete would leave a row pointing at bytes that no
 * longer exist -- strictly worse than an orphaned object, which costs storage and nothing else.
 */
export async function deleteSubmissionAttachment(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
  attachmentId: string,
): Promise<void> {
  await assertOwnsSubmission(tx, schoolId, submissionId);

  const [row] = await tx<{ id: string; original_file_name: string }[]>`
    DELETE FROM app.submission_attachments
    WHERE id = ${attachmentId}
      AND submission_id = ${submissionId}
      AND school_id = ${schoolId}
    RETURNING id, original_file_name
  `;

  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Attachment not found");
  }

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "submission_attachments",
    targetId: row.id,
    oldValues: { submission_id: submissionId, original_file_name: row.original_file_name },
  });
}

/**
 * Load attachments for a page of submissions in one query.
 *
 * Batched rather than per-submission because the list endpoint hydrates a whole class roster at
 * once, and a per-row lookup would turn one page into N+1 round trips. Returns a Map keyed by
 * submission id so the caller can attach them without a nested scan.
 */
export async function listAttachmentsBySubmission(
  tx: TransactionSql,
  schoolId: string,
  submissionIds: readonly string[],
): Promise<Map<string, SubmissionAttachmentRow[]>> {
  const grouped = new Map<string, SubmissionAttachmentRow[]>();
  if (submissionIds.length === 0) return grouped;

  const rows = await tx<SubmissionAttachmentRow[]>`
    SELECT id, submission_id, storage_key, original_file_name, mime_type,
           size_bytes, checksum_sha256, attempt_number, uploaded_by_user_id, created_at
    FROM app.submission_attachments
    WHERE school_id = ${schoolId}
      AND submission_id IN ${tx(submissionIds as string[])}
    ORDER BY attempt_number ASC, created_at ASC, id ASC
  `;

  for (const row of rows) {
    const existing = grouped.get(row.submission_id);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.submission_id, [row]);
    }
  }

  return grouped;
}
