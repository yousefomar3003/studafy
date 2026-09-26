import { ERROR_CODES } from "@studafy/constants";
import {
  planStudentImport,
  readCsvSource,
  REQUIRED_STUDENT_IMPORT_FIELDS,
  stageRows,
  suggestColumnMapping,
} from "@studafy/student-import";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { ImportDiffResponse, ImportRowError, ImportStatus, ImportSummary } from "./schemas";
import type {
  ColumnMapping,
  CsvSource,
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

function importColumns(tx: TransactionSql) {
  return tx`
    id, school_id, uploaded_by, confirmed_by, status, file_name, idempotency_key,
    row_count, valid_rows, error_rows, header_line, source_headers, column_mapping,
    errors, summary, created_at, updated_at, confirmed_at, completed_at
  `;
}

function mappingColumns(tx: TransactionSql) {
  return tx`id, name, column_mapping, created_by, created_at, updated_at`;
}

// ---------------------------------------------------------------------------
// Upload, re-map, confirm
// ---------------------------------------------------------------------------

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
): Promise<ImportRecord> {
  const source = readCsvSource(rawCsv);

  if (source.rows.length > MAX_ROWS) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.IMPORT_ROWS_EXCEED_LIMIT,
      `CSV exceeds the maximum of ${MAX_ROWS} rows (found ${source.rows.length}).`,
    );
  }

  const mapping = mappingId
    ? (await getMapping(tx, schoolId, mappingId)).column_mapping
    : suggestColumnMapping(source.headers);
  const staged = stageRows(source, mapping);
  const validRows = countValid(staged.rows);

  const [created] = await tx<ImportRecord[]>`
    INSERT INTO app.student_imports (
      school_id, uploaded_by, status, file_name, row_count, valid_rows, error_rows,
      header_line, source_headers, column_mapping, errors
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
      ${tx.json(staged.issues as unknown as JSONValue)}::jsonb
    )
    RETURNING ${importColumns(tx)}
  `;
  const record = deserializeRecord(created!);

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
  const staged = stageRows(source, mapping);
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
): Promise<{ rows: ImportRecord[]; next_cursor: string | null }> {
  const statusFilter = params.status ? tx` AND status = ${params.status}::app.import_status` : tx``;

  // Cursor is "timestamp:id" — decode and use for keyset pagination.
  const cursorFilter = params.cursor
    ? (() => {
        const sep = params.cursor.lastIndexOf(":");
        const createdAt = params.cursor.slice(0, sep);
        const id = params.cursor.slice(sep + 1);
        return tx` AND (created_at, id) < (${createdAt}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  // One row beyond the page, so its presence says whether another page exists.
  const rows = await tx<ImportRecord[]>`
    SELECT ${importColumns(tx)}
    FROM app.student_imports
    WHERE school_id = ${schoolId}
      ${statusFilter}
      ${cursorFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT ${params.limit + 1}
  `;

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const lastRow = page[page.length - 1];
  const next_cursor =
    hasMore && lastRow ? `${lastRow.created_at.toISOString()}:${lastRow.id}` : null;

  return { rows: page.map(deserializeRecord), next_cursor };
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
      // Rows staged before ST-299 (backfilled from rows_data) have no parent_name key.
      record: { ...row.record, parent_name: row.record.parent_name ?? null },
    })),
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
        link: row.link,
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
