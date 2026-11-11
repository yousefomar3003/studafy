/**
 * Which stored files a data subject request's export copies into its archive.
 *
 * - **A whole school (closure):** every file the school and its users uploaded and Studafy still
 *   holds: class materials, assignment and submission attachments, question images, record
 *   documents, expense attachments, licence payment receipts and original student import files.
 * - **One person:** the files that are theirs. Attachments on their own submissions (as a student),
 *   and materials and assignment attachments they uploaded. Their record documents come from
 *   records-dsr.ts. Other people's files are never included: a parent's export does not carry their
 *   child's submissions, and a teacher's does not carry the students' work they marked.
 *
 * Each query is explicit rather than discovered from column names: a table holding a file has its
 * own name column (or none), and a guess would either miss a file or copy someone else's.
 *
 * Files attached to private messages are not reachable: app.message_attachments is readable only by
 * the two people in the conversation, and no admin identity this pipeline can act as is one of them
 * (MESSAGE_FILES_EXPORT_GAP).
 */

import type { SubjectIdentifiers } from "./subject-resolver";
import type { TransactionSql } from "postgres";

export interface ExportFileSource {
  /** The table that references the file. */
  table: string;
  /** That table's row id (for a record document, the answer id). */
  sourceId: string;
  storageKey: string;
  /** The name the file had when it was uploaded, or the last segment of its key. */
  originalFileName: string;
  /** The checksum recorded at upload, when the table keeps one. */
  checksumSha256: string | null;
  /** The size recorded at upload, when the table keeps one. */
  sizeBytes: number | null;
}

export const MESSAGE_FILES_EXPORT_GAP =
  "app.messages, app.message_attachments: private messages and the files attached to them can be " +
  "read only by the two people in the conversation, so this export does not include them.";

/** The archive folder each source table's files are copied into. */
export const EXPORT_FILE_FOLDERS: Readonly<Record<string, string>> = {
  submission_attachments: "submissions",
  assignment_attachments: "assignment-attachments",
  materials: "materials",
  assignment_questions: "question-images",
  record_documents: "record-documents",
  expense_cache: "expense-attachments",
  license_payment_receipts: "payment-receipts",
  license_payments: "payment-receipts",
  student_imports: "student-imports",
};

interface FileRow {
  table: string;
  source_id: string;
  storage_key: string;
  file_name: string | null;
  checksum_sha256: string | null;
  size_bytes: string | number | null;
}

/** The last segment of a storage key: keys end with the uploaded file's name. */
function keyBaseName(key: string): string {
  const segments = key.split("/");
  return segments[segments.length - 1] || "file";
}

function toSource(row: FileRow): ExportFileSource {
  return {
    table: row.table,
    sourceId: row.source_id,
    storageKey: row.storage_key,
    originalFileName: row.file_name ?? keyBaseName(row.storage_key),
    checksumSha256: row.checksum_sha256,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  };
}

/** Every file the school holds. A table with no name column (question images, expense and
 * licence payment receipts) is named by its key's last segment, the uploaded file's name. */
async function schoolFiles(tx: TransactionSql, schoolId: string): Promise<FileRow[]> {
  return tx<FileRow[]>`
    SELECT 'materials' AS table, id::text AS source_id, storage_key,
           original_file_name AS file_name, checksum_sha256, size_bytes
    FROM app.materials WHERE school_id = ${schoolId}::uuid
    UNION ALL
    SELECT 'assignment_attachments', id::text, storage_key, original_file_name, checksum_sha256,
           size_bytes
    FROM app.assignment_attachments WHERE school_id = ${schoolId}::uuid
    UNION ALL
    SELECT 'submission_attachments', id::text, storage_key, original_file_name, checksum_sha256,
           size_bytes
    FROM app.submission_attachments WHERE school_id = ${schoolId}::uuid
    UNION ALL
    SELECT 'assignment_questions', id::text, image_storage_key, NULL, NULL, image_size_bytes
    FROM app.assignment_questions
    WHERE school_id = ${schoolId}::uuid AND image_storage_key IS NOT NULL
    UNION ALL
    SELECT 'expense_cache', id::text, attachment_storage_key, NULL, NULL, NULL
    FROM app.expense_cache
    WHERE school_id = ${schoolId}::uuid AND attachment_storage_key IS NOT NULL
    UNION ALL
    SELECT 'license_payment_receipts', id::text, storage_key, file_name, NULL, size_bytes
    FROM app.license_payment_receipts WHERE school_id = ${schoolId}::uuid
    UNION ALL
    SELECT 'license_payments', id::text, receipt_storage_key, NULL, NULL, NULL
    FROM app.license_payments
    WHERE school_id = ${schoolId}::uuid AND receipt_storage_key IS NOT NULL
    UNION ALL
    SELECT 'student_imports', id::text, source_storage_key, source_file_name, NULL,
           source_size_bytes
    FROM app.student_imports
    WHERE school_id = ${schoolId}::uuid AND source_storage_key IS NOT NULL
    ORDER BY 1, 2
  `;
}

async function subjectFiles(
  tx: TransactionSql,
  schoolId: string,
  subject: SubjectIdentifiers,
): Promise<FileRow[]> {
  // Attachments on the person's own submissions, whoever attached them: the submission is theirs.
  const ownSubmissions = subject.studentId
    ? tx`
        UNION ALL
        SELECT 'submission_attachments', a.id::text, a.storage_key, a.original_file_name,
               a.checksum_sha256, a.size_bytes
        FROM app.submission_attachments AS a
        JOIN app.assignment_submissions AS s
          ON s.id = a.submission_id AND s.school_id = a.school_id
        WHERE a.school_id = ${schoolId}::uuid AND s.student_id = ${subject.studentId}::uuid
      `
    : tx``;
  return tx<FileRow[]>`
    SELECT 'materials' AS table, id::text AS source_id, storage_key,
           original_file_name AS file_name, checksum_sha256, size_bytes
    FROM app.materials
    WHERE school_id = ${schoolId}::uuid AND uploaded_by_user_id = ${subject.userId}::uuid
    UNION ALL
    SELECT 'assignment_attachments', id::text, storage_key, original_file_name, checksum_sha256,
           size_bytes
    FROM app.assignment_attachments
    WHERE school_id = ${schoolId}::uuid AND uploaded_by_user_id = ${subject.userId}::uuid
    ${ownSubmissions}
    ORDER BY 1, 2
  `;
}

/**
 * The files to copy, except record documents (records-dsr.ts finds those with the answers they
 * belong to). Runs inside the export's transaction, as the resolved admin actor.
 */
export async function listExportFiles(
  tx: TransactionSql,
  schoolId: string,
  subject: SubjectIdentifiers | undefined,
): Promise<ExportFileSource[]> {
  const rows = subject
    ? await subjectFiles(tx, schoolId, subject)
    : await schoolFiles(tx, schoolId);
  return rows.map(toSource);
}
