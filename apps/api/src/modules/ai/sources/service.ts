import { createHash, randomUUID } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import {
  AI_ASSIGNMENT_SOURCE_LIST_LIMIT,
  AI_ASSIGNMENT_SOURCE_MIME_TYPE,
  AI_ASSIGNMENT_SOURCE_REQUEUE_MINUTES,
  AI_SOURCE_MAX_BYTES_PER_STUDENT,
  AI_SOURCE_MAX_PER_STUDENT,
  AI_SOURCE_PENDING_UPLOAD_GRACE_MINUTES,
} from "./limits";

import type { TransactionSql } from "postgres";

/**
 * A student's AI sources other than class study materials (000232), stored as app.materials rows:
 *
 *  - `personal`: a file or photo the student uploaded. Owned by the student; the role-scope policy
 *    shows it to them alone. Uploaded like a material (presigned PUT into permanent/, confirm, then
 *    the malware scan and AI ingestion), counted on the school's storage meter, and capped per
 *    student (limits.ts).
 *  - `assignment`: an assignment's text and the teacher's attached files, read as one source. One
 *    row per assignment, shared by every student who can see it; the ingestion worker reads the
 *    assignment and its (already scanned) attachments in place, so no file is copied. Rebuilt when
 *    the assignment's text or attachments change.
 *
 * Every function runs in the caller's tenant transaction as the signed-in student (the AI routes'
 * student-self gate has already matched `studentId` to the caller), so RLS is the backstop for
 * every query here: a source the student may not see reads as absent.
 */

export type AiSourceKind = "personal" | "assignment";

/** One source as the API returns it. */
export interface AiSourceRow {
  id: string;
  kind: AiSourceKind;
  title: string;
  original_file_name: string | null;
  mime_type: string;
  size_bytes: number;
  /** The material pipeline state (app.material_ingest_status). */
  status: string;
  error: string | null;
  /** True once ingestion found text to work with; a ready photo with none is not usable. */
  has_text: boolean;
  assignment_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The personal source the upload confirm and delete act on. */
interface PersonalSourceRecord {
  id: string;
  storage_key: string;
  ingest_status: string;
  uploaded_by_user_id: string;
  size_bytes: number;
}

export interface AiSourceUsage {
  count: number;
  bytes: number;
  max_count: number;
  max_bytes: number;
}

function notFound(): CodedHttpException {
  return new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Source not found.");
}

/** The columns of {@link AiSourceRow}, read from `app.materials AS m`. */
function sourceColumns(tx: TransactionSql) {
  return tx`
    m.id, m.source_kind AS kind, m.title,
    CASE WHEN m.source_kind = 'personal' THEN m.original_file_name END AS original_file_name,
    m.mime_type, m.size_bytes::float8 AS size_bytes, m.ingest_status::text AS status,
    m.ingest_error AS error,
    EXISTS (
      SELECT 1 FROM app.material_chunks AS c
      WHERE c.school_id = m.school_id AND c.material_id = m.id
    ) AS has_text,
    m.assignment_id, m.created_at, m.updated_at
  `;
}

// ---------------------------------------------------------------------------
// Personal sources
// ---------------------------------------------------------------------------

export async function listPersonalSources(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<AiSourceRow[]> {
  return tx<AiSourceRow[]>`
    SELECT ${sourceColumns(tx)}
    FROM app.materials AS m
    WHERE m.school_id = ${schoolId}::uuid
      AND m.source_kind = 'personal'
      AND m.owner_student_id = ${studentId}::uuid
    ORDER BY m.created_at DESC, m.id
  `;
}

/**
 * What the student's own sources hold against the per-student caps. An unconfirmed upload counts
 * only while its PUT may still be in flight (see AI_SOURCE_PENDING_UPLOAD_GRACE_MINUTES).
 */
export async function personalSourceUsage(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<AiSourceUsage> {
  const [row] = await tx<{ count: number; bytes: number }[]>`
    SELECT count(*)::int AS count, COALESCE(sum(size_bytes), 0)::float8 AS bytes
    FROM app.materials
    WHERE school_id = ${schoolId}::uuid
      AND source_kind = 'personal'
      AND owner_student_id = ${studentId}::uuid
      AND (
        ingest_status <> 'uploaded'::app.material_ingest_status
        OR created_at > CURRENT_TIMESTAMP
          - make_interval(mins => ${AI_SOURCE_PENDING_UPLOAD_GRACE_MINUTES})
      )
  `;
  return {
    count: row?.count ?? 0,
    bytes: Number(row?.bytes ?? 0),
    max_count: AI_SOURCE_MAX_PER_STUDENT,
    max_bytes: AI_SOURCE_MAX_BYTES_PER_STUDENT,
  };
}

export interface InitiatePersonalUploadParams {
  schoolId: string;
  userId: string;
  studentId: string;
  title: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Create the source row for a new upload and return its storage key; the route signs the PUT.
 * Refuses past the per-student caps (422 AI_SOURCE_LIMIT_REACHED). The school's own storage quota
 * is the route's check, in the same transaction.
 */
export async function initiatePersonalUpload(
  tx: TransactionSql,
  params: InitiatePersonalUploadParams,
): Promise<{ source: AiSourceRow; storageKey: string }> {
  // Serialize one student's concurrent uploads on their student row, so two parallel requests cannot
  // both pass the cap check below.
  await tx`
    SELECT 1 FROM app.students
    WHERE id = ${params.studentId}::uuid AND school_id = ${params.schoolId}::uuid
    FOR UPDATE
  `;

  const usage = await personalSourceUsage(tx, params.schoolId, params.studentId);
  if (
    usage.count >= AI_SOURCE_MAX_PER_STUDENT ||
    usage.bytes + params.sizeBytes > AI_SOURCE_MAX_BYTES_PER_STUDENT
  ) {
    throw new CodedHttpException(
      422,
      ERROR_CODES.AI_SOURCE_LIMIT_REACHED,
      "You have reached the limit for your own AI study files.",
    );
  }

  // Unique per upload (uq_materials_storage_key); the random prefix keeps two "notes.pdf" apart and
  // the slug keeps the key readable. Same scheme as a class material, under its own folder.
  const fileSlug = params.originalFileName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 80);
  const storageKey = `permanent/${params.schoolId}/ai-sources/${randomUUID()}-${fileSlug}`;

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.materials (
      school_id, class_id, source_kind, owner_student_id,
      uploaded_by_user_id, last_edited_by_user_id,
      title, storage_key, original_file_name, mime_type, size_bytes, ai_visible
    ) VALUES (
      ${params.schoolId}::uuid, NULL, 'personal', ${params.studentId}::uuid,
      ${params.userId}::uuid, ${params.userId}::uuid,
      ${params.title}, ${storageKey}, ${params.originalFileName}, ${params.mimeType},
      ${params.sizeBytes}, true
    )
    RETURNING id
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "materials",
    targetId: row!.id,
    newValues: { source_kind: "personal", storage_key: storageKey },
  });

  const source = await getSource(tx, params.schoolId, row!.id);
  return { source: source!, storageKey };
}

async function getPersonalSourceForUpdate(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  sourceId: string,
): Promise<PersonalSourceRecord | undefined> {
  const [row] = await tx<PersonalSourceRecord[]>`
    SELECT id, storage_key, ingest_status::text AS ingest_status, uploaded_by_user_id,
           size_bytes::float8 AS size_bytes
    FROM app.materials
    WHERE id = ${sourceId}::uuid AND school_id = ${schoolId}::uuid
      AND source_kind = 'personal' AND owner_student_id = ${studentId}::uuid
    FOR UPDATE
  `;
  return row;
}

/**
 * Confirm a finished upload: flip it to `scanning` (the scan job's claim) with the stored size the
 * route read from the bucket, and credit the school's storage meter with it. The route enqueues the
 * scan once this commits.
 */
export async function confirmPersonalUpload(
  tx: TransactionSql,
  params: {
    schoolId: string;
    studentId: string;
    sourceId: string;
    storageKey: string;
    storedSizeBytes: number;
  },
): Promise<{ source: AiSourceRow; uploadedByUserId: string }> {
  const existing = await getPersonalSourceForUpdate(
    tx,
    params.schoolId,
    params.studentId,
    params.sourceId,
  );
  if (!existing) throw notFound();
  if (existing.storage_key !== params.storageKey) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Storage key does not match the source.",
    );
  }
  if (existing.ingest_status !== "uploaded") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.MATERIAL_INGEST_IN_PROGRESS,
      `Source is already in ${existing.ingest_status} state.`,
    );
  }

  await tx`
    UPDATE app.materials
    SET ingest_status = 'scanning'::app.material_ingest_status,
        size_bytes = ${params.storedSizeBytes},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${params.sourceId}::uuid AND school_id = ${params.schoolId}::uuid
  `;
  await tx`SELECT app.add_storage_usage(${params.storedSizeBytes})`;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "materials",
    targetId: params.sourceId,
    oldValues: { ingest_status: "uploaded" },
    newValues: { ingest_status: "scanning" },
  });

  const source = await getSource(tx, params.schoolId, params.sourceId);
  return { source: source!, uploadedByUserId: existing.uploaded_by_user_id };
}

/**
 * Delete one of the student's own sources. Its chunks cascade, and with them every quiz question,
 * flashcard and exam item grounded on it. Returns the stored objects for the route to free once
 * this commits (free-objects.ts), the way deleting a class material does.
 */
export async function deletePersonalSource(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  sourceId: string,
): Promise<{ storageKeys: string[] }> {
  const [removed] = await tx<
    { storage_key: string; thumbnail_key: string | null; preview_key: string | null }[]
  >`
    DELETE FROM app.materials
    WHERE id = ${sourceId}::uuid AND school_id = ${schoolId}::uuid
      AND source_kind = 'personal' AND owner_student_id = ${studentId}::uuid
    RETURNING storage_key, thumbnail_key, preview_key
  `;
  if (!removed) throw notFound();

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "materials",
    targetId: sourceId,
    oldValues: { source_kind: "personal", storage_key: removed.storage_key },
  });

  return {
    storageKeys: [removed.storage_key, removed.thumbnail_key, removed.preview_key].filter(
      (key): key is string => key !== null,
    ),
  };
}

/**
 * One source the student can use, of either kind: their own, or an assignment source of a class
 * they can read. Class study materials are not sources here.
 */
export async function getSource(
  tx: TransactionSql,
  schoolId: string,
  sourceId: string,
): Promise<AiSourceRow | undefined> {
  const [row] = await tx<AiSourceRow[]>`
    SELECT ${sourceColumns(tx)}
    FROM app.materials AS m
    WHERE m.id = ${sourceId}::uuid AND m.school_id = ${schoolId}::uuid
      AND m.source_kind IN ('personal', 'assignment')
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Assignment sources
// ---------------------------------------------------------------------------

/** One assignment the student can use as a source, with its source's state if it was built. */
export interface AssignmentSourceCandidate {
  assignment_id: string;
  title: string;
  class_id: string;
  class_code: string | null;
  due_at: Date;
  attachment_count: number;
  ai_enabled: boolean;
  source_id: string | null;
  source_status: string | null;
}

/**
 * The student's assignments, the same ones the assignment list shows a student: not a draft (nor
 * archived), in a class they are actively enrolled in. Most recent due date first.
 */
function studentAssignmentPredicate(tx: TransactionSql, studentId: string) {
  return tx`
    a.status IN ('published'::app.assignment_status, 'closed'::app.assignment_status)
    AND EXISTS (
      SELECT 1 FROM app.enrollments AS e
      WHERE e.school_id = a.school_id AND e.class_id = a.class_id
        AND e.student_id = ${studentId}::uuid AND e.status = 'active'
    )
  `;
}

export async function listAssignmentSourceCandidates(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<AssignmentSourceCandidate[]> {
  return tx<AssignmentSourceCandidate[]>`
    SELECT a.id AS assignment_id, a.title, a.class_id, cl.code AS class_code, a.due_at,
           (SELECT count(*)::int FROM app.assignment_attachments AS f
            WHERE f.school_id = a.school_id AND f.assignment_id = a.id
              AND f.scan_status IN ('clean', 'unscanned')) AS attachment_count,
           COALESCE(cl.ai_materials_enabled, false) AS ai_enabled,
           m.id AS source_id, m.ingest_status::text AS source_status
    FROM app.assignments AS a
    LEFT JOIN app.classes AS cl ON cl.id = a.class_id AND cl.school_id = a.school_id
    LEFT JOIN app.materials AS m
      ON m.school_id = a.school_id AND m.assignment_id = a.id AND m.source_kind = 'assignment'
    WHERE a.school_id = ${schoolId}::uuid AND ${studentAssignmentPredicate(tx, studentId)}
    ORDER BY a.due_at DESC, a.id
    LIMIT ${AI_ASSIGNMENT_SOURCE_LIST_LIMIT}
  `;
}

interface AssignmentForSource {
  id: string;
  class_id: string;
  created_by_user_id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  ai_enabled: boolean;
}

/**
 * What an assignment source is built from, hashed: a change to any of it means the source must be
 * rebuilt. Attachments count only once their malware scan has cleared them, which is also all the
 * ingestion worker reads.
 */
export function assignmentSourceFingerprint(
  assignment: Pick<AssignmentForSource, "title" | "description" | "instructions">,
  attachments: readonly { id: string; storage_key: string }[],
): string {
  const files = [...attachments]
    .map((file) => `${file.id}:${file.storage_key}`)
    .sort()
    .join("\n");
  return createHash("sha256")
    .update(
      JSON.stringify([assignment.title, assignment.description, assignment.instructions, files]),
    )
    .digest("hex");
}

/** The source row's file-name column: the assignment's title, made a valid file name. */
function assignmentSourceFileName(title: string): string {
  const cleaned = title.replace(/[/\\]/g, "-").trim().slice(0, 200);
  return cleaned === "" ? "assignment" : cleaned;
}

export interface PreparedAssignmentSource {
  source: AiSourceRow;
  /** True when the source was (re)staged for ingestion and the caller must enqueue its job. */
  enqueue: boolean;
}

/**
 * Make sure the assignment's AI source exists and is current, staging it for ingestion when it is
 * new, out of date, or failed. Idempotent: an unchanged, ready source is returned as it is, so every
 * student of the class shares one ingestion. 404 for an assignment the student cannot use; 422
 * AI_SOURCE_AI_DISABLED when the class's AI materials setting is off.
 */
export async function prepareAssignmentSource(
  tx: TransactionSql,
  params: { schoolId: string; studentId: string; assignmentId: string },
): Promise<PreparedAssignmentSource> {
  const [assignment] = await tx<AssignmentForSource[]>`
    SELECT a.id, a.class_id, a.created_by_user_id, a.title, a.description, a.instructions,
           COALESCE(cl.ai_materials_enabled, false) AS ai_enabled
    FROM app.assignments AS a
    LEFT JOIN app.classes AS cl ON cl.id = a.class_id AND cl.school_id = a.school_id
    WHERE a.id = ${params.assignmentId}::uuid AND a.school_id = ${params.schoolId}::uuid
      AND ${studentAssignmentPredicate(tx, params.studentId)}
  `;
  if (!assignment) throw notFound();
  if (!assignment.ai_enabled) {
    throw new CodedHttpException(
      422,
      ERROR_CODES.AI_SOURCE_AI_DISABLED,
      "The AI study tools are turned off for this class.",
    );
  }

  const attachments = await tx<{ id: string; storage_key: string; size_bytes: number }[]>`
    SELECT id, storage_key, size_bytes::float8 AS size_bytes
    FROM app.assignment_attachments
    WHERE school_id = ${params.schoolId}::uuid AND assignment_id = ${params.assignmentId}::uuid
      AND scan_status IN ('clean', 'unscanned')
  `;
  const fingerprint = assignmentSourceFingerprint(assignment, attachments);
  const textBytes = Buffer.byteLength(
    [assignment.title, assignment.description ?? "", assignment.instructions ?? ""].join("\n"),
  );
  // Informational (the source stores no file and is never metered): what it was built from.
  const sizeBytes = Math.max(
    1,
    textBytes + attachments.reduce((sum, file) => sum + Number(file.size_bytes), 0),
  );
  const fileName = assignmentSourceFileName(assignment.title);

  // One row per assignment, whoever asks first. The creator of record is the assignment's author:
  // the content is theirs, and the source must not outlive (or be erased with) the student who
  // happened to open it first.
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO app.materials (
      school_id, class_id, source_kind, assignment_id,
      uploaded_by_user_id, last_edited_by_user_id,
      title, storage_key, original_file_name, mime_type, size_bytes, ai_visible,
      ingest_status, source_fingerprint
    ) VALUES (
      ${params.schoolId}::uuid, ${assignment.class_id}::uuid, 'assignment',
      ${params.assignmentId}::uuid,
      ${assignment.created_by_user_id}::uuid, ${assignment.created_by_user_id}::uuid,
      ${assignment.title}, NULL, ${fileName}, ${AI_ASSIGNMENT_SOURCE_MIME_TYPE}, ${sizeBytes}, true,
      'queued'::app.material_ingest_status, ${fingerprint}
    )
    ON CONFLICT (school_id, assignment_id) DO NOTHING
    RETURNING id
  `;
  if (inserted[0]) {
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "materials",
      targetId: inserted[0].id,
      newValues: { source_kind: "assignment", assignment_id: params.assignmentId },
    });
    const source = await getSource(tx, params.schoolId, inserted[0].id);
    return { source: source!, enqueue: true };
  }

  const [existing] = await tx<
    { id: string; ingest_status: string; source_fingerprint: string | null; stale: boolean }[]
  >`
    SELECT id, ingest_status::text AS ingest_status, source_fingerprint,
           updated_at < CURRENT_TIMESTAMP
             - make_interval(mins => ${AI_ASSIGNMENT_SOURCE_REQUEUE_MINUTES}) AS stale
    FROM app.materials
    WHERE school_id = ${params.schoolId}::uuid AND assignment_id = ${params.assignmentId}::uuid
      AND source_kind = 'assignment'
    FOR UPDATE
  `;
  if (!existing) throw notFound();

  const changed = existing.source_fingerprint !== fingerprint;
  // A changed assignment is rebuilt from wherever it stands; a failed build is retried; and a
  // queued one whose job was lost long ago is handed to the queue again. `processing` is left to
  // its worker: the fingerprint check on the next request catches a change made meanwhile.
  const restage =
    (changed && existing.ingest_status !== "processing") || existing.ingest_status === "failed";
  const requeueLost = existing.ingest_status === "queued" && existing.stale;

  if (restage) {
    await tx`
      UPDATE app.materials
      SET ingest_status = 'queued'::app.material_ingest_status,
          ingest_error = NULL,
          ingested_at = NULL,
          title = ${assignment.title},
          original_file_name = ${fileName},
          size_bytes = ${sizeBytes},
          source_fingerprint = ${fingerprint},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${existing.id}::uuid AND school_id = ${params.schoolId}::uuid
    `;
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "materials",
      targetId: existing.id,
      oldValues: { ingest_status: existing.ingest_status },
      newValues: { ingest_status: "queued", rebuilt: changed },
    });
  } else if (requeueLost) {
    await tx`
      UPDATE app.materials SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ${existing.id}::uuid AND school_id = ${params.schoolId}::uuid
    `;
  }

  const source = await getSource(tx, params.schoolId, existing.id);
  return { source: source!, enqueue: restage || requeueLost };
}
