/**
 * School-defined record data in the GDPR pipeline (docs/modules/student-records.md "DSR").
 *
 * The generic walk (tenant-export.worker.ts / tenant-erasure.worker.ts) cannot serve these tables:
 * a sensitive answer is ciphertext, so dumping its row would hand the subject bytes instead of their
 * data; a parent's answers are keyed by `parent_user_id`, which SUBJECT_LINK_COLUMNS does not reach;
 * and redaction by column name would leave every answer in place. So both halves skip
 * RECORD_DATA_TABLES and call in here instead:
 *
 *   - export: every answer about the subject (as a student and as a parent), opened with the
 *     records keyring and labelled with the field as it read when answered, plus document metadata;
 *   - erasure: the answers are deleted outright (documents cascade), and the stored files' keys are
 *     returned for the caller to delete once its transaction has committed.
 */

import { openRecordValue } from "@studafy/records";

import type { SubjectIdentifiers } from "./subject-resolver";
import type { RecordKeyring, RecordSubjectKind, RecordValue } from "@studafy/records";
import type { TransactionSql } from "postgres";

export const RECORD_DATA_TABLES: ReadonlySet<string> = new Set([
  "record_answers",
  "record_documents",
]);

interface AnswerExportRow {
  answer_id: string;
  subject_kind: RecordSubjectKind;
  subject_id: string;
  field_id: string;
  field_type: string;
  label_en: string;
  label_ar: string;
  sensitivity: "standard" | "sensitive";
  value: RecordValue | null;
  value_ciphertext: Uint8Array | null;
  value_key_id: string | null;
  value_mask: string | null;
  updated_at: Date;
  document_status: string | null;
  document_storage_key: string | null;
  document_file_name: string | null;
  document_mime_type: string | null;
  document_expires_on: string | null;
  document_verified_at: Date | null;
}

function subjectFilter(tx: TransactionSql, subject: SubjectIdentifiers | undefined) {
  if (!subject) return tx``;
  return subject.studentId
    ? tx`AND (a.parent_user_id = ${subject.userId}::uuid OR a.student_id = ${subject.studentId}::uuid)`
    : tx`AND a.parent_user_id = ${subject.userId}::uuid`;
}

export interface RecordExport {
  /** NDJSON lines, one per answer. */
  lines: string[];
  files: { storageKey: string; originalFileName: string }[];
}

export async function exportRecordData(
  tx: TransactionSql,
  schoolId: string,
  subject: SubjectIdentifiers | undefined,
  keyring: RecordKeyring,
): Promise<RecordExport> {
  const rows = await tx<AnswerExportRow[]>`
    SELECT a.id AS answer_id, a.subject_kind, a.subject_id, a.field_id, fv.field_type::text,
           fv.label_en, fv.label_ar, fv.sensitivity::text AS sensitivity, a.value,
           a.value_ciphertext, a.value_key_id, a.value_mask, a.updated_at,
           d.status::text AS document_status, d.storage_key AS document_storage_key,
           d.original_file_name AS document_file_name, d.mime_type AS document_mime_type,
           to_char(d.expires_on, 'YYYY-MM-DD') AS document_expires_on,
           d.verified_at AS document_verified_at
    FROM app.record_answers AS a
    JOIN app.record_field_versions AS fv
      ON fv.id = a.field_version_id AND fv.school_id = a.school_id
    LEFT JOIN app.record_documents AS d ON d.answer_id = a.id AND d.school_id = a.school_id
    WHERE a.school_id = ${schoolId}::uuid
      ${subjectFilter(tx, subject)}
    ORDER BY a.subject_kind, a.subject_id, fv.sort_order
  `;

  const lines: string[] = [];
  const files: RecordExport["files"] = [];
  for (const row of rows) {
    // The subject is entitled to their own data in full (GDPR art. 15), sensitive or not.
    const value =
      row.value_ciphertext !== null
        ? openRecordValue(
            keyring,
            {
              schoolId,
              subjectKind: row.subject_kind,
              subjectId: row.subject_id,
              fieldId: row.field_id,
            },
            { ciphertext: row.value_ciphertext, keyId: row.value_key_id!, mask: row.value_mask! },
          ).unwrap()
        : row.value;
    lines.push(
      JSON.stringify({
        subject_kind: row.subject_kind,
        subject_id: row.subject_id,
        field_id: row.field_id,
        field_type: row.field_type,
        label_en: row.label_en,
        label_ar: row.label_ar,
        sensitivity: row.sensitivity,
        value,
        updated_at: row.updated_at.toISOString(),
        document:
          row.document_status === null
            ? null
            : {
                status: row.document_status,
                original_file_name: row.document_file_name,
                content_type: row.document_mime_type,
                storage_key: row.document_storage_key,
                expires_on: row.document_expires_on,
                verified_at: row.document_verified_at?.toISOString() ?? null,
              },
      }),
    );
    if (row.document_storage_key && row.document_file_name) {
      files.push({
        storageKey: row.document_storage_key,
        originalFileName: row.document_file_name,
      });
    }
  }
  return { lines, files };
}

export interface RecordErasure {
  rows: number;
  /** Stored document files to delete once the erasure transaction has committed. */
  storageKeys: string[];
}

export async function eraseRecordData(
  tx: TransactionSql,
  schoolId: string,
  subject: SubjectIdentifiers | undefined,
): Promise<RecordErasure> {
  const documents = await tx<{ storage_key: string }[]>`
    SELECT d.storage_key
    FROM app.record_documents AS d
    JOIN app.record_answers AS a ON a.id = d.answer_id AND a.school_id = d.school_id
    WHERE d.school_id = ${schoolId}::uuid AND d.storage_key IS NOT NULL
      ${subjectFilter(tx, subject)}
  `;
  const deleted = await tx`
    DELETE FROM app.record_answers AS a
    WHERE a.school_id = ${schoolId}::uuid
      ${subjectFilter(tx, subject)}
  `;
  return { rows: deleted.count, storageKeys: documents.map((row) => row.storage_key) };
}
