import { ERROR_CODES } from "@studafy/constants";
import { maskRecordValue } from "@studafy/records";
import {
  planStudentImport,
  readCsvSource,
  REQUIRED_STUDENT_IMPORT_FIELDS,
  stageRows,
  suggestColumnMapping,
  unmappedColumns,
  withRecordDefaults,
} from "@studafy/student-import";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { getPublishedForm } from "../records/template-service";

import { DEFAULT_SOURCE_RETENTION_DAYS } from "./source-service";

import type {
  ImportDiffResponse,
  ImportRowError,
  ImportStatus,
  ImportSummary,
  SourceRemovedReason,
} from "./schemas";
import type { StagedSourceFile } from "./source-service";
import type {
  ColumnMapping,
  CsvSource,
  ImportRecordField,
  StagedRow,
  StudentImportAction,
  StudentImportRecord,
} from "@studafy/student-import";
import type { JSONValue, TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportRecord {
  id: string;
  school_id: string;
  uploaded_by: string;
  confirmed_by: string | null;
  status: ImportStatus;
  file_name: string;
  idempotency_key: string | null;
  row_count: number;
  valid_rows: number;
  error_rows: number;
  header_line: number;
  source_headers: string[];
  column_mapping: ColumnMapping;
  errors: ImportRowError[];
  summary: ImportSummary | null;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
  completed_at: Date | null;
  source_storage_key: string | null;
  source_file_name: string | null;
  source_size_bytes: number | null;
  source_uploaded_at: Date | null;
  source_removed_at: Date | null;
  source_removed_reason: SourceRemovedReason | null;
  cells_purged_at: Date | null;
  /** The school's retention period, for the file's and the leftover cells' expiry. */
  retention_days: number;
}

/** An import as the history lists it: who ran it, and what is left of its file. */
export interface ImportListRecord extends ImportRecord {
  uploaded_by_name: string | null;
  confirmed_by_name: string | null;
  unmapped_column_count: number;
  cells_available: boolean;
}

export interface StudentImportMapping {
  id: string;
  name: string;
  column_mapping: ColumnMapping;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const MAX_ROWS = 10_000;

/** Staging rows per statement. A 10,000-row upload is five round trips, not ten thousand. */
const STAGING_BATCH_SIZE = 2_000;

/** Only an unconfirmed import may be re-mapped; once confirmed, the worker owns its staging rows. */
const REMAPPABLE_STATUSES: readonly ImportStatus[] = ["uploaded", "validated"];

/**
 * Every column of an import record, usable in a SELECT and in INSERT/UPDATE ... RETURNING alike
 * (both may reference the target table by name).
 */
function importColumns(tx: TransactionSql) {
  return tx`
    student_imports.id, student_imports.school_id, student_imports.uploaded_by,
    student_imports.confirmed_by, student_imports.status, student_imports.file_name,
    student_imports.idempotency_key, student_imports.row_count, student_imports.valid_rows,
    student_imports.error_rows, student_imports.header_line, student_imports.source_headers,
    student_imports.column_mapping, student_imports.errors, student_imports.summary,
    student_imports.created_at, student_imports.updated_at, student_imports.confirmed_at,
    student_imports.completed_at, student_imports.source_storage_key,
    student_imports.source_file_name, student_imports.source_size_bytes::int AS source_size_bytes,
    student_imports.source_uploaded_at, student_imports.source_removed_at,
    student_imports.source_removed_reason, student_imports.cells_purged_at,
    coalesce(
      (SELECT settings.source_retention_days FROM app.student_import_settings AS settings
       WHERE settings.school_id = student_imports.school_id),
      ${DEFAULT_SOURCE_RETENTION_DAYS}
    )::int AS retention_days
  `;
}

function mappingColumns(tx: TransactionSql) {
  return tx`id, name, column_mapping, created_by, created_at, updated_at`;
}

/**
 * The published student record form's fields, offered as import columns
 * (docs/modules/student-records.md "CSV import"). Document fields are included so a mapping that
 * names one is refused with a reason rather than as an unknown field.
 */
export async function importRecordFields(
  tx: TransactionSql,
  schoolId: string,
): Promise<ImportRecordField[]> {
  const form = await getPublishedForm(tx, schoolId, "student");
  return form.fields.map((field) => ({
    id: field.id,
    field_type: field.field_type,
    options: field.options,
    label_en: field.label_en,
    label_ar: field.label_ar,
    sensitivity: field.sensitivity,
  }));
}

// ---------------------------------------------------------------------------
// Upload, re-map, confirm
// ---------------------------------------------------------------------------

/**
 * Every way an upload can be refused before anything is written: the CSV parses, is within the
 * row cap, and the named mapping exists. The upload route runs it ahead of copying a kept original
 * out of temp/, so a refused file is never copied (it would hold student data with no row, and so
 * no retention sweep, pointing at it).
 */
export async function checkImportUpload(
  tx: TransactionSql,
  schoolId: string,
  rawCsv: string,
  mappingId?: string,
) {
  const source = readCsvSource(rawCsv);

  if (source.rows.length > MAX_ROWS) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.IMPORT_ROWS_EXCEED_LIMIT,
      `CSV exceeds the maximum of ${MAX_ROWS} rows (found ${source.rows.length}).`,
    );
  }

  const recordFields = await importRecordFields(tx, schoolId);
  const mapping = mappingId
    ? (await getMapping(tx, schoolId, mappingId)).column_mapping
    : suggestColumnMapping(source.headers, recordFields);
  return { source, recordFields, mapping };
}

/**
 * Parse a CSV, detect its header row, map it (a saved mapping, or one suggested from the headers)
 * and stage every data line. Stored as `validated` when every line is valid, `uploaded` otherwise.
 */
export async function uploadImport(
  tx: TransactionSql,
  schoolId: string,
  uploadedBy: string,
  fileName: string,
  rawCsv: string,
  mappingId?: string,
  stageSource?: () => Promise<StagedSourceFile>,
): Promise<ImportRecord> {
  const { source, recordFields, mapping } = await checkImportUpload(
    tx,
    schoolId,
    rawCsv,
    mappingId,
  );
  const staged = stageRows(source, mapping, recordFields);
  const validRows = countValid(staged.rows);
  // After the file has parsed: a file refused for its content is never kept.
  const file = stageSource ? await stageSource() : null;

  const [created] = await tx<ImportRecord[]>`
    INSERT INTO app.student_imports (
      school_id, uploaded_by, status, file_name, row_count, valid_rows, error_rows,
      header_line, source_headers, column_mapping, errors, source_storage_key, source_file_name,
      source_size_bytes, source_uploaded_at, source_scan_status
    ) VALUES (
      ${schoolId},
      ${uploadedBy},
      ${statusFor(staged.issues)}::app.import_status,
      ${fileName},
      ${staged.rows.length},
      ${validRows},
      ${staged.rows.length - validRows},
      ${source.header_line},
      ${tx.json(source.headers)}::jsonb,
      ${tx.json(mapping as JSONValue)}::jsonb,
      ${tx.json(staged.issues as unknown as JSONValue)}::jsonb,
      ${file?.storageKey ?? null},
      ${file?.fileName ?? null},
      ${file?.sizeBytes ?? null},
      ${file ? tx`CURRENT_TIMESTAMP` : null},
      ${file ? "scanning" : "unscanned"}::app.upload_scan_status
    )
    RETURNING ${importColumns(tx)}
  `;
  const record = deserializeRecord(created!);
  await replaceUnmappedColumns(tx, schoolId, record.id, source.headers, mapping);

  for (let i = 0; i < staged.rows.length; i += STAGING_BATCH_SIZE) {
    const chunk = staged.rows.slice(i, i + STAGING_BATCH_SIZE);
    await tx`
      INSERT INTO app.student_import_rows (school_id, import_id, line_number, source, record)
      SELECT ${schoolId}::uuid, ${record.id}::uuid, row.line_number, row.source, row.record
      FROM jsonb_to_recordset(${tx.json(chunk as unknown as JSONValue)}::jsonb)
        AS row (line_number int, source jsonb, record jsonb)
    `;
  }

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "student_imports",
    targetId: record.id,
    newValues: {
      file_name: fileName,
      source_file_kept: file !== null,
      mapping_id: mappingId ?? null,
      column_mapping: mapping,
      row_count: record.row_count,
      valid_rows: record.valid_rows,
      error_rows: record.error_rows,
    },
  });

  return record;
}

/**
 * Re-apply a new column mapping to an unconfirmed import's staged rows, without a re-upload, and
 * optionally save the mapping for the school.
 */
export async function updateImportMapping(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  importId: string,
  mapping: ColumnMapping,
  saveAs?: string,
): Promise<ImportRecord> {
  const [locked] = await tx<ImportRecord[]>`
    SELECT ${importColumns(tx)}
    FROM app.student_imports
    WHERE id = ${importId}::uuid AND school_id = ${schoolId}
    FOR UPDATE
  `;
  if (!locked) {
    throw new CodedHttpException(404, ERROR_CODES.IMPORT_NOT_FOUND, "Import not found.");
  }
  const current = deserializeRecord(locked);
  if (!REMAPPABLE_STATUSES.includes(current.status)) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.IMPORT_INVALID_STATE,
      `Import is ${current.status}; only an unconfirmed import can be re-mapped.`,
    );
  }

  const sourceRows = await tx<{ line_number: number; source: Record<string, string> }[]>`
    SELECT line_number, source
    FROM app.student_import_rows
    WHERE school_id = ${schoolId} AND import_id = ${importId}::uuid
    ORDER BY line_number
  `;
  const source: CsvSource = {
    header_line: current.header_line,
    headers: current.source_headers,
    rows: sourceRows.map((row) => ({ line_number: row.line_number, source: row.source })),
  };
  const staged = stageRows(source, mapping, await importRecordFields(tx, schoolId));
  const validRows = countValid(staged.rows);

  for (let i = 0; i < staged.rows.length; i += STAGING_BATCH_SIZE) {
    const chunk = staged.rows
      .slice(i, i + STAGING_BATCH_SIZE)
      .map((row) => ({ line_number: row.line_number, record: row.record }));
    await tx`
      UPDATE app.student_import_rows AS staged
      SET record = next.record
      FROM jsonb_to_recordset(${tx.json(chunk as unknown as JSONValue)}::jsonb)
        AS next (line_number int, record jsonb)
      WHERE staged.school_id = ${schoolId}
        AND staged.import_id = ${importId}::uuid
        AND staged.line_number = next.line_number
    `;
  }

  const [updated] = await tx<ImportRecord[]>`
    UPDATE app.student_imports
    SET status = ${statusFor(staged.issues)}::app.import_status,
        column_mapping = ${tx.json(mapping as JSONValue)}::jsonb,
        valid_rows = ${validRows},
        error_rows = ${staged.rows.length - validRows},
        errors = ${tx.json(staged.issues as unknown as JSONValue)}::jsonb,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${importId}::uuid AND school_id = ${schoolId}
    RETURNING ${importColumns(tx)}
  `;
  const record = deserializeRecord(updated!);
  await replaceUnmappedColumns(tx, schoolId, importId, current.source_headers, mapping);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "student_imports",
    targetId: importId,
    oldValues: {
      status: current.status,
      column_mapping: current.column_mapping,
      valid_rows: current.valid_rows,
      error_rows: current.error_rows,
    },
    newValues: {
      status: record.status,
      column_mapping: mapping,
      valid_rows: record.valid_rows,
      error_rows: record.error_rows,
    },
  });

  if (saveAs !== undefined) await createMapping(tx, schoolId, userId, saveAs, mapping);

  return record;
}

/**
 * Confirm a staged import. Transitions status to `confirmed` and records who confirmed it and the
 * idempotency key. If the key already exists, returns that import instead.
 */
export async function confirmImport(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  importId: string,
  idempotencyKey?: string,
): Promise<ImportRecord> {
  if (idempotencyKey) {
    const [existing] = await tx<ImportRecord[]>`
      SELECT ${importColumns(tx)}
      FROM app.student_imports
      WHERE school_id = ${schoolId} AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    if (existing) return deserializeRecord(existing);
  }

  const [previous] = await tx<{ status: ImportStatus }[]>`
    SELECT status FROM app.student_imports
    WHERE id = ${importId}::uuid AND school_id = ${schoolId}
    FOR UPDATE
  `;

  const [confirmed] = await tx<ImportRecord[]>`
    UPDATE app.student_imports
    SET status = 'confirmed'::app.import_status,
        idempotency_key = ${idempotencyKey ?? null},
        confirmed_by = ${userId}::uuid,
        confirmed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${importId}::uuid
      AND school_id = ${schoolId}
      AND status IN ('uploaded', 'validated')
    RETURNING ${importColumns(tx)}
  `;

  if (!confirmed) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.IMPORT_NOT_FOUND,
      "Import not found or not in a confirmable state.",
    );
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "student_imports",
    targetId: importId,
    oldValues: { status: previous!.status },
    newValues: { status: "confirmed", idempotency_key: idempotencyKey ?? null },
  });

  return deserializeRecord(confirmed);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getImport(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
): Promise<ImportRecord> {
  const [record] = await tx<ImportRecord[]>`
    SELECT ${importColumns(tx)}
    FROM app.student_imports
    WHERE id = ${importId}::uuid AND school_id = ${schoolId}
  `;

  if (!record) {
    throw new CodedHttpException(404, ERROR_CODES.IMPORT_NOT_FOUND, "Import not found.");
  }

  return deserializeRecord(record);
}

/** List imports with keyset pagination on (created_at, id). */
export async function listImports(
  tx: TransactionSql,
  schoolId: string,
  params: { limit: number; cursor?: string; status?: ImportStatus },
): Promise<{ rows: ImportListRecord[]; next_cursor: string | null }> {
  const statusFilter = params.status
    ? tx` AND student_imports.status = ${params.status}::app.import_status`
    : tx``;

  // Cursor is "timestamp:id" — decode and use for keyset pagination.
  const cursorFilter = params.cursor
    ? (() => {
        const sep = params.cursor.lastIndexOf(":");
        const createdAt = params.cursor.slice(0, sep);
        const id = params.cursor.slice(sep + 1);
        return tx` AND (student_imports.created_at, student_imports.id) < (${createdAt}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  // One row beyond the page, so its presence says whether another page exists.
  const rows = await tx<ImportListRecord[]>`
    SELECT ${importColumns(tx)},
           uploader.display_name AS uploaded_by_name,
           confirmer.display_name AS confirmed_by_name,
           EXISTS (
             SELECT 1 FROM app.student_import_rows AS cell
             WHERE cell.school_id = student_imports.school_id
               AND cell.import_id = student_imports.id
           ) AS cells_available
    FROM app.student_imports
    LEFT JOIN app.users AS uploader
      ON uploader.id = student_imports.uploaded_by AND uploader.school_id = student_imports.school_id
    LEFT JOIN app.users AS confirmer
      ON confirmer.id = student_imports.confirmed_by
     AND confirmer.school_id = student_imports.school_id
    WHERE student_imports.school_id = ${schoolId}
      ${statusFilter}
      ${cursorFilter}
    ORDER BY student_imports.created_at DESC, student_imports.id DESC
    LIMIT ${params.limit + 1}
  `;

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const lastRow = page[page.length - 1];
  const next_cursor =
    hasMore && lastRow ? `${lastRow.created_at.toISOString()}:${lastRow.id}` : null;

  return {
    rows: page.map((row) => {
      const record = deserializeRecord(row);
      // Counted from the headers and mapping, as the columns endpoint lists them, so an import
      // uploaded before unmapped columns were recorded still shows its count.
      const unmapped = unmappedColumns(record.source_headers, record.column_mapping).length;
      return { ...row, ...record, unmapped_column_count: unmapped };
    }),
    next_cursor,
  };
}

/**
 * The dry-run diff: what migrating this import would do to live data right now. Read-only; the
 * worker recomputes the same plan inside its migration transaction, so this is a preview, not a
 * reservation.
 */
export async function getImportDiff(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
  action?: StudentImportAction,
): Promise<ImportDiffResponse> {
  await getImport(tx, schoolId, importId);

  const staged = await tx<{ line_number: number; record: StudentImportRecord }[]>`
    SELECT line_number, record
    FROM app.student_import_rows
    WHERE school_id = ${schoolId} AND import_id = ${importId}::uuid AND record IS NOT NULL
    ORDER BY line_number
  `;
  const plan = await planStudentImport(
    tx,
    schoolId,
    staged.map((row) => ({
      line_number: row.line_number,
      // Rows staged by an earlier release lack the fields added since; missing means "not given".
      record: withRecordDefaults(row.record),
    })),
  );

  const fields = new Map(
    (await importRecordFields(tx, schoolId)).map((field) => [field.id, field]),
  );

  return {
    import_id: importId,
    totals: plan.totals,
    rows: plan.rows
      .filter((row) => action === undefined || row.action === action)
      .map((row) => ({
        line_number: row.line_number,
        admission_number: row.record.admission_number,
        action: row.action,
        conflict: row.conflict,
        changes: row.changes,
        parent: row.parent,
        parent_conflict: row.parent_conflict,
        parent_group_line: row.parent_group_line,
        parent_email: row.record.parent_email,
        parent_name: row.record.parent_name,
        parent_phone: row.record.parent_phone,
        link: row.link,
        parent2:
          row.parent2 === null
            ? null
            : {
                parent: row.parent2.parent,
                parent_conflict: row.parent2.parent_conflict,
                parent_group_line: row.parent2.parent_group_line,
                parent_email: row.record.parent2_email,
                parent_name: row.record.parent2_name,
                parent_phone: row.record.parent2_phone,
                link: row.parent2.link,
              },
        family: row.record.family,
        grade: row.record.grade,
        section: row.record.section,
        placement: row.placement?.action ?? null,
        placement_conflict: row.placement_conflict,
        // In form order: the staged answers are a jsonb object, which keeps no key order.
        records: [...fields.values()].flatMap((field) => {
          const fieldId = field.id;
          const value = row.record.records?.[fieldId];
          if (value === undefined) return [];
          // The preview is a non-reveal response like any other: a sensitive cell is its mask.
          const sensitive = field.sensitivity === "sensitive";
          return [
            {
              field_id: fieldId,
              label_en: field.label_en,
              label_ar: field.label_ar,
              value: sensitive ? null : value,
              mask: sensitive ? maskRecordValue(field.field_type, value) : null,
            },
          ];
        }),
      })),
  };
}

// ---------------------------------------------------------------------------
// Saved mappings
// ---------------------------------------------------------------------------

export async function listMappings(
  tx: TransactionSql,
  schoolId: string,
): Promise<StudentImportMapping[]> {
  return tx<StudentImportMapping[]>`
    SELECT ${mappingColumns(tx)}
    FROM app.student_import_mappings
    WHERE school_id = ${schoolId}
    ORDER BY normalized_name
  `;
}

export async function getMapping(
  tx: TransactionSql,
  schoolId: string,
  mappingId: string,
): Promise<StudentImportMapping> {
  const [mapping] = await tx<StudentImportMapping[]>`
    SELECT ${mappingColumns(tx)}
    FROM app.student_import_mappings
    WHERE id = ${mappingId}::uuid AND school_id = ${schoolId}
  `;
  if (!mapping) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.IMPORT_MAPPING_NOT_FOUND,
      "Saved column mapping not found.",
    );
  }
  return mapping;
}

export async function createMapping(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  name: string,
  columnMapping: ColumnMapping,
): Promise<StudentImportMapping> {
  assertCompleteMapping(columnMapping);

  // ON CONFLICT turns a duplicate name into a 409 with its own code, rather than a raw unique
  // violation surfacing as a 500.
  const [created] = await tx<StudentImportMapping[]>`
    INSERT INTO app.student_import_mappings (school_id, name, column_mapping, created_by)
    VALUES (${schoolId}, ${name}, ${tx.json(columnMapping as JSONValue)}::jsonb, ${userId}::uuid)
    ON CONFLICT (school_id, normalized_name) DO NOTHING
    RETURNING ${mappingColumns(tx)}
  `;
  if (!created) throw nameExists(name);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "student_import_mappings",
    targetId: created.id,
    newValues: { name, column_mapping: columnMapping },
  });

  return created;
}

export async function updateMapping(
  tx: TransactionSql,
  schoolId: string,
  mappingId: string,
  changes: { name?: string; column_mapping?: ColumnMapping },
): Promise<StudentImportMapping> {
  const current = await getMapping(tx, schoolId, mappingId);
  if (changes.column_mapping) assertCompleteMapping(changes.column_mapping);

  if (changes.name !== undefined) {
    const [taken] = await tx<{ id: string }[]>`
      SELECT id FROM app.student_import_mappings
      WHERE school_id = ${schoolId}
        AND normalized_name = lower(btrim(${changes.name}))
        AND id <> ${mappingId}::uuid
    `;
    if (taken) throw nameExists(changes.name);
  }

  const name = changes.name ?? current.name;
  const columnMapping = changes.column_mapping ?? current.column_mapping;
  const [updated] = await tx<StudentImportMapping[]>`
    UPDATE app.student_import_mappings
    SET name = ${name},
        column_mapping = ${tx.json(columnMapping as JSONValue)}::jsonb,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${mappingId}::uuid AND school_id = ${schoolId}
    RETURNING ${mappingColumns(tx)}
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "student_import_mappings",
    targetId: mappingId,
    oldValues: { name: current.name, column_mapping: current.column_mapping },
    newValues: { name, column_mapping: columnMapping },
  });

  return updated!;
}

/** Deleting a saved mapping never affects an import staged with it: imports keep a snapshot. */
export async function deleteMapping(
  tx: TransactionSql,
  schoolId: string,
  mappingId: string,
): Promise<void> {
  const current = await getMapping(tx, schoolId, mappingId);
  await tx`
    DELETE FROM app.student_import_mappings
    WHERE id = ${mappingId}::uuid AND school_id = ${schoolId}
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "student_import_mappings",
    targetId: mappingId,
    oldValues: { name: current.name, column_mapping: current.column_mapping },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A saved mapping is only reusable if it maps every required field. */
function assertCompleteMapping(mapping: ColumnMapping): void {
  const missing = REQUIRED_STUDENT_IMPORT_FIELDS.filter((field) => mapping[field] === undefined);
  if (missing.length > 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.IMPORT_MAPPING_INVALID,
      `The mapping does not map required fields: ${missing.join(", ")}.`,
    );
  }
}

function nameExists(name: string): CodedHttpException {
  return new CodedHttpException(
    409,
    ERROR_CODES.IMPORT_MAPPING_NAME_EXISTS,
    `A saved column mapping named "${name}" already exists.`,
  );
}

/**
 * Record which source columns the import's mapping leaves unread: the history lists them, staff map
 * them later, and the platform counts their (normalized) header text across schools. Re-mapping an
 * unconfirmed import replaces the set; nothing has been applied from an unconfirmed import.
 */
async function replaceUnmappedColumns(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
  headers: readonly string[],
  mapping: ColumnMapping,
): Promise<void> {
  await tx`
    DELETE FROM app.student_import_unmapped_columns
    WHERE school_id = ${schoolId} AND import_id = ${importId}::uuid
  `;
  const columns = unmappedColumns(headers, mapping).map((column) => ({
    position: column.position,
    header: column.header.slice(0, 500),
    normalized_header: column.normalized_header.slice(0, 500),
  }));
  if (columns.length === 0) return;
  await tx`
    INSERT INTO app.student_import_unmapped_columns
      (school_id, import_id, position, header, normalized_header)
    SELECT ${schoolId}::uuid, ${importId}::uuid, col.position, col.header, col.normalized_header
    FROM jsonb_to_recordset(${tx.json(columns as unknown as JSONValue)}::jsonb)
      AS col (position int, header text, normalized_header text)
  `;
}

function statusFor(issues: readonly unknown[]): ImportStatus {
  return issues.length > 0 ? "uploaded" : "validated";
}

function countValid(rows: readonly StagedRow[]): number {
  return rows.filter((row) => row.record !== null).length;
}

function deserializeRecord(row: ImportRecord): ImportRecord {
  return {
    ...row,
    source_headers: Array.isArray(row.source_headers) ? row.source_headers : [],
    column_mapping: row.column_mapping ?? {},
    errors: Array.isArray(row.errors) ? row.errors : [],
    summary: row.summary ?? null,
  };
}
