/**
 * School-defined record data in the GDPR pipeline (docs/modules/student-records.md "DSR").
 *
 * The generic walk (tenant-export.worker.ts / tenant-erasure.worker.ts) cannot serve these tables:
 * a sensitive answer is ciphertext, so dumping its row would hand the subject bytes instead of their
 * data; a parent's answers are keyed by `parent_user_id`, which SUBJECT_LINK_COLUMNS does not reach;
 * and redaction by column name would leave every answer in place. So both halves skip
 * RECORD_DATA_TABLES and call in here instead:
 *
 *   - export: every answer about the subject (as a student, a parent and a member of staff),
 *     opened with the records keyring and labelled with the field as it read when answered, plus
 *     document metadata;
 *   - erasure: the answers are deleted outright (documents cascade), and the stored files' keys are
 *     returned for the caller to delete once its transaction has committed.
 *
 * A class's record is not about a person (000181): no per-person request reaches it -- its
 * class_id never matches a subject -- and only a tenant closure, which takes every answer, removes
 * it. A staff member's answers are keyed by `staff_user_id`, the person's own user id.
 *
 * Custom lists (000182, docs/modules/custom-lists.md) are handled here for the same reasons: a
 * sensitive cell is ciphertext, and a cell (app.custom_list_values) has no link column at all -- it
 * reaches a person only through its row. So:
 *
 *   - export: every row linked to the subject (as a student by student_id, as a parent or member of
 *     staff by user_id), with its list's name and each cell labelled by its column, sensitive cells
 *     opened; a tenant closure exports every row of every list;
 *   - erasure: the subject's linked rows are deleted outright (their cells cascade); a tenant
 *     closure deletes every list, which cascades to its columns, choices, rows and cells. A row
 *     linked to a class, or to no one, is about no person and is reached only by a closure.
 */

import { openRecordValue } from "@studafy/records";

import type { SubjectIdentifiers } from "./subject-resolver";
import type { RecordKeyring, RecordSubjectKind, RecordValue } from "@studafy/records";
import type { TransactionSql } from "postgres";

export const RECORD_DATA_TABLES: ReadonlySet<string> = new Set([
  "record_answers",
  "record_documents",
  "custom_list_rows",
  "custom_list_values",
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
  document_size_bytes: string | number | null;
  document_expires_on: string | null;
  document_verified_at: Date | null;
}

function subjectFilter(tx: TransactionSql, subject: SubjectIdentifiers | undefined) {
  if (!subject) return tx``;
  const asUser = tx`(a.parent_user_id = ${subject.userId}::uuid OR a.staff_user_id = ${subject.userId}::uuid)`;
  return subject.studentId
    ? tx`AND (${asUser} OR a.student_id = ${subject.studentId}::uuid)`
    : tx`AND ${asUser}`;
}

export interface RecordExport {
  /** One JSON object per answer. */
  lines: string[];
  /** The answers' stored documents; `sourceId` is the answer id. */
  files: { sourceId: string; storageKey: string; originalFileName: string; sizeBytes: number }[];
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
           d.size_bytes AS document_size_bytes,
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
        sourceId: row.answer_id,
        storageKey: row.document_storage_key,
        originalFileName: row.document_file_name,
        sizeBytes: Number(row.document_size_bytes ?? 0),
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

// ---------------------------------------------------------------------------
// Custom lists (000182)
// ---------------------------------------------------------------------------

interface CustomListRowExport {
  row_id: string;
  list_id: string;
  name_en: string;
  name_ar: string;
  link_kind: string | null;
  link_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface CustomListValueExport {
  row_id: string;
  column_id: string;
  label_en: string;
  label_ar: string;
  field_type: string;
  sensitivity: "standard" | "sensitive";
  column_archived: boolean;
  value_text: string | null;
  value_number: string | null;
  value_date: string | null;
  value_bool: boolean | null;
  option_value: string | null;
  option_label_en: string | null;
  option_label_ar: string | null;
  value_ciphertext: Uint8Array | null;
  value_key_id: string | null;
  value_mask: string | null;
}

interface ExportedCell {
  column_id: string;
  label_en: string;
  label_ar: string;
  field_type: string;
  sensitivity: "standard" | "sensitive";
  column_archived: boolean;
  value: RecordValue | null;
  choices?: { value: string; label_en: string; label_ar: string }[];
}

function customListSubjectFilter(tx: TransactionSql, subject: SubjectIdentifiers | undefined) {
  if (!subject) return tx``;
  const asUser = tx`r.user_id = ${subject.userId}::uuid`;
  return subject.studentId
    ? tx`AND (${asUser} OR r.student_id = ${subject.studentId}::uuid)`
    : tx`AND ${asUser}`;
}

/** NDJSON lines, one per custom list row linked to the subject (every row, for a closure). */
export async function exportCustomListData(
  tx: TransactionSql,
  schoolId: string,
  subject: SubjectIdentifiers | undefined,
  keyring: RecordKeyring,
): Promise<string[]> {
  const rows = await tx<CustomListRowExport[]>`
    SELECT r.id AS row_id, r.list_id, l.name_en, l.name_ar, r.link_kind::text AS link_kind,
           coalesce(r.student_id, r.user_id, r.class_id) AS link_id, r.created_at, r.updated_at
    FROM app.custom_list_rows AS r
    JOIN app.custom_lists AS l ON l.id = r.list_id AND l.school_id = r.school_id
    WHERE r.school_id = ${schoolId}::uuid
      ${customListSubjectFilter(tx, subject)}
    ORDER BY lower(l.name_en), r.list_id, r.created_at, r.id
  `;
  if (rows.length === 0) return [];
  const values = await tx<CustomListValueExport[]>`
    SELECT v.row_id, v.column_id, c.label_en, c.label_ar, c.field_type::text AS field_type,
           c.sensitivity::text AS sensitivity, (c.archived_at IS NOT NULL) AS column_archived,
           v.value_text, v.value_number::text AS value_number,
           to_char(v.value_date, 'YYYY-MM-DD') AS value_date, v.value_bool,
           o.value AS option_value, o.label_en AS option_label_en, o.label_ar AS option_label_ar,
           v.value_ciphertext, v.value_key_id, v.value_mask
    FROM app.custom_list_values AS v
    JOIN app.custom_list_columns AS c ON c.id = v.column_id AND c.school_id = v.school_id
    LEFT JOIN app.custom_list_column_options AS o
      ON o.id = v.option_id AND o.school_id = v.school_id
    WHERE v.school_id = ${schoolId}::uuid
      AND v.row_id = ANY(${rows.map((row) => row.row_id)}::uuid[])
    ORDER BY v.row_id, c.sort_order, c.id, o.sort_order
  `;

  const cellsByRow = new Map<string, Map<string, ExportedCell>>();
  for (const value of values) {
    const cells = cellsByRow.get(value.row_id) ?? new Map<string, ExportedCell>();
    cellsByRow.set(value.row_id, cells);
    let cell = cells.get(value.column_id);
    if (!cell) {
      cell = {
        column_id: value.column_id,
        label_en: value.label_en,
        label_ar: value.label_ar,
        field_type: value.field_type,
        sensitivity: value.sensitivity,
        column_archived: value.column_archived,
        value: null,
      };
      cells.set(value.column_id, cell);
    }
    if (value.value_ciphertext !== null) {
      // The subject is entitled to their own data in full (GDPR art. 15), sensitive or not.
      cell.value = openRecordValue(
        keyring,
        {
          schoolId,
          subjectKind: "custom_list_row",
          subjectId: value.row_id,
          fieldId: value.column_id,
        },
        { ciphertext: value.value_ciphertext, keyId: value.value_key_id!, mask: value.value_mask! },
      ).unwrap();
    } else if (value.option_value !== null) {
      const choice = {
        value: value.option_value,
        label_en: value.option_label_en!,
        label_ar: value.option_label_ar!,
      };
      cell.choices = [...(cell.choices ?? []), choice];
      cell.value =
        value.field_type === "multi_choice"
          ? cell.choices.map((option) => option.value)
          : choice.value;
    } else if (value.value_number !== null) {
      cell.value = Number(value.value_number);
    } else if (value.value_date !== null) {
      cell.value = value.value_date;
    } else if (value.value_bool !== null) {
      cell.value = value.value_bool;
    } else {
      cell.value = value.value_text;
    }
  }

  return rows.map((row) =>
    JSON.stringify({
      list_id: row.list_id,
      list_name_en: row.name_en,
      list_name_ar: row.name_ar,
      row_id: row.row_id,
      link_kind: row.link_kind,
      link_id: row.link_id,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      cells: [...(cellsByRow.get(row.row_id)?.values() ?? [])],
    }),
  );
}

export interface CustomListErasure {
  /** Rows deleted (their cells cascade). */
  rows: number;
  /** Lists deleted: a tenant closure only. */
  lists: number;
}

export async function eraseCustomListData(
  tx: TransactionSql,
  schoolId: string,
  subject: SubjectIdentifiers | undefined,
): Promise<CustomListErasure> {
  if (subject) {
    const deleted = await tx`
      DELETE FROM app.custom_list_rows AS r
      WHERE r.school_id = ${schoolId}::uuid
        ${customListSubjectFilter(tx, subject)}
    `;
    return { rows: deleted.count, lists: 0 };
  }
  const [counted] = await tx<{ rows: number }[]>`
    SELECT count(*)::int AS rows FROM app.custom_list_rows WHERE school_id = ${schoolId}::uuid
  `;
  // A list cascades to its columns, their choices, its rows and every cell (000182).
  const lists = await tx`DELETE FROM app.custom_lists WHERE school_id = ${schoolId}::uuid`;
  return { rows: counted?.rows ?? 0, lists: lists.count };
}
