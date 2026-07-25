import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import { csvStudentRowSchema } from "./schemas";

import type { ImportRowError, ImportStatus, ImportSummary } from "./schemas";
import type { JSONValue, TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportRow {
  admission_number: string;
  email: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  status: string;
  parent_email: string | null;
  parent_relationship: string | null;
}

export interface ImportRecord {
  id: string;
  school_id: string;
  uploaded_by: string;
  status: ImportStatus;
  file_name: string;
  idempotency_key: string | null;
  row_count: number;
  valid_rows: number;
  error_rows: number;
  rows_data: ImportRow[];
  errors: ImportRowError[];
  summary: ImportSummary | null;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
  completed_at: Date | null;
}

// ---------------------------------------------------------------------------
// CSV parsing — hand-rolled, zero-dependency
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string into rows of string arrays.
 * Handles quoted fields, escaped quotes (""). Does not handle multiline fields
 * (which are invalid for our template anyway).
 *
 * Line numbers are 1-based, skipping the header row.
 */
export function parseCsvRows(raw: string): { headers: string[]; rows: string[][] } {
  const lines = splitCsvLines(raw);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = parseCsvLine(lines[0]!);
  const rows: string[][] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    rows.push(parseCsvLine(line));
  }

  return { headers, rows };
}

function splitCsvLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.split("\n");
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }

  fields.push(current);
  return fields;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_ROWS = 10_000;

const REQUIRED_HEADERS = ["admission_number", "email", "first_name", "last_name"] as const;

type HeaderMap = Record<string, number>;

function buildHeaderMap(headers: string[]): HeaderMap {
  const map: HeaderMap = {};
  for (let i = 0; i < headers.length; i++) {
    map[headers[i]!.trim().toLowerCase()] = i;
  }
  return map;
}

/**
 * Validate a parsed CSV and return row-level errors.
 * Returns structured rows for valid data alongside error descriptors.
 */
export function validateCsv(
  headers: string[],
  rows: string[][],
): { validRows: ImportRow[]; errors: ImportRowError[] } {
  const errors: ImportRowError[] = [];
  const validRows: ImportRow[] = [];

  const headerMap = buildHeaderMap(headers);

  // Check required headers are present.
  for (const required of REQUIRED_HEADERS) {
    if (headerMap[required] === undefined) {
      errors.push({ line: 1, field: required, message: `Missing required column "${required}".` });
    }
  }

  // If required columns are missing, still process rows to surface individual errors.
  for (let i = 0; i < rows.length; i++) {
    const lineNum = i + 2; // 1-based, +1 for header
    const csvRow = rows[i]!;
    const record: Record<string, string> = {};

    for (const [header, idx] of Object.entries(headerMap)) {
      record[header] = csvRow[idx]?.trim() ?? "";
    }

    // Validate via Zod — safeParse collects the first error per field.
    const parsed = csvStudentRowSchema.safeParse({
      admission_number: record.admission_number || undefined,
      email: record.email || undefined,
      first_name: record.first_name || undefined,
      middle_name: record.middle_name || undefined,
      last_name: record.last_name || undefined,
      preferred_name: record.preferred_name || undefined,
      date_of_birth: record.date_of_birth || undefined,
      status: record.status || "applicant",
      parent_email: record.parent_email || undefined,
      parent_relationship: record.parent_relationship || undefined,
    });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.join(".") || "row";
        errors.push({ line: lineNum, field, message: issue.message });
      }
      continue;
    }

    const data = parsed.data;
    validRows.push({
      admission_number: data.admission_number,
      email: data.email,
      first_name: data.first_name,
      middle_name: data.middle_name ?? null,
      last_name: data.last_name,
      preferred_name: data.preferred_name ?? null,
      date_of_birth: data.date_of_birth ?? null,
      status: data.status,
      parent_email: data.parent_email ?? null,
      parent_relationship: data.parent_relationship ?? null,
    });
  }

  return { validRows, errors };
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Upload and validate a CSV. Stores the import record in `uploaded` status.
 * Returns the import record with row-level validation errors.
 */
export async function uploadImport(
  tx: TransactionSql,
  schoolId: string,
  uploadedBy: string,
  fileName: string,
  rawCsv: string,
): Promise<ImportRecord> {
  const { headers, rows } = parseCsvRows(rawCsv);

  if (rows.length > MAX_ROWS) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.IMPORT_ROWS_EXCEED_LIMIT,
      `CSV exceeds the maximum of ${MAX_ROWS} rows (found ${rows.length}).`,
    );
  }

  const { validRows, errors } = validateCsv(headers, rows);
  const hasErrors = errors.length > 0;
  const status: ImportStatus = hasErrors ? "uploaded" : "validated";

  const [record] = await tx<ImportRecord[]>`
    INSERT INTO app.student_imports (
      school_id, uploaded_by, status, file_name,
      row_count, valid_rows, error_rows,
      rows_data, errors
    ) VALUES (
      ${schoolId},
      ${uploadedBy},
      ${status}::app.import_status,
      ${fileName},
      ${rows.length},
      ${validRows.length},
      ${errors.length > 0 ? rows.length - validRows.length : rows.length},
      ${tx.json(validRows as unknown as JSONValue)}::jsonb,
      ${tx.json(errors as unknown as JSONValue)}::jsonb
    )
    RETURNING id, school_id, uploaded_by, status, file_name, idempotency_key,
              row_count, valid_rows, error_rows, rows_data, errors, summary,
              created_at, updated_at, confirmed_at, completed_at
  `;

  return deserializeRecord(record!);
}

/**
 * Confirm a validated import. Transitions status to `confirmed` and records the idempotency key.
 * If an idempotency key is provided and already exists, returns the existing import.
 */
export async function confirmImport(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
  idempotencyKey?: string,
): Promise<ImportRecord> {
  // Check for existing import with this idempotency key.
  if (idempotencyKey) {
    const [existing] = await tx<ImportRecord[]>`
      SELECT id, school_id, uploaded_by, status, file_name, idempotency_key,
             row_count, valid_rows, error_rows, rows_data, errors, summary,
             created_at, updated_at, confirmed_at, completed_at
      FROM app.student_imports
      WHERE school_id = ${schoolId} AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;

    if (existing) {
      return deserializeRecord(existing);
    }
  }

  const [record] = await tx<ImportRecord[]>`
    UPDATE app.student_imports
    SET status = 'confirmed'::app.import_status,
        idempotency_key = ${idempotencyKey ?? null},
        confirmed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${importId}::uuid
      AND school_id = ${schoolId}
      AND status IN ('uploaded', 'validated')
    RETURNING id, school_id, uploaded_by, status, file_name, idempotency_key,
              row_count, valid_rows, error_rows, rows_data, errors, summary,
              created_at, updated_at, confirmed_at, completed_at
  `;

  if (!record) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.IMPORT_NOT_FOUND,
      "Import not found or not in a confirmable state.",
    );
  }

  return deserializeRecord(record);
}

/**
 * Get import status and summary.
 */
export async function getImport(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
): Promise<ImportRecord> {
  const [record] = await tx<ImportRecord[]>`
    SELECT id, school_id, uploaded_by, status, file_name, idempotency_key,
           row_count, valid_rows, error_rows, rows_data, errors, summary,
           created_at, updated_at, confirmed_at, completed_at
    FROM app.student_imports
    WHERE id = ${importId}::uuid AND school_id = ${schoolId}
  `;

  if (!record) {
    throw new CodedHttpException(404, ERROR_CODES.IMPORT_NOT_FOUND, "Import not found.");
  }

  return deserializeRecord(record);
}

/**
 * List imports with cursor-based pagination.
 */
export async function listImports(
  tx: TransactionSql,
  schoolId: string,
  params: { limit: number; cursor?: string; status?: ImportStatus },
): Promise<{ rows: ImportRecord[]; next_cursor: string | null }> {
  const statusFilter = params.status ? tx` AND status = ${params.status}::app.import_status` : tx``;

  const limit = params.limit + 1;

  // Cursor is "timestamp:id" — decode and use for keyset pagination.
  const cursorFilter = params.cursor
    ? (() => {
        const sep = params.cursor.lastIndexOf(":");
        const createdAt = params.cursor.slice(0, sep);
        const id = params.cursor.slice(sep + 1);
        return tx` AND (created_at, id) < (${createdAt}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const rows = await tx<ImportRecord[]>`
    SELECT id, school_id, uploaded_by, status, file_name, idempotency_key,
           row_count, valid_rows, error_rows, rows_data, errors, summary,
           created_at, updated_at, confirmed_at, completed_at
    FROM app.student_imports
    WHERE school_id = ${schoolId}
      ${statusFilter}
      ${cursorFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const lastRow = sliced[sliced.length - 1];
  const next_cursor =
    hasMore && lastRow ? `${lastRow.created_at.toISOString()}:${lastRow.id}` : null;

  return {
    rows: sliced.map(deserializeRecord),
    next_cursor,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deserializeRecord(row: ImportRecord): ImportRecord {
  return {
    ...row,
    status: row.status as ImportStatus,
    rows_data: Array.isArray(row.rows_data) ? (row.rows_data as unknown as ImportRow[]) : [],
    errors: Array.isArray(row.errors) ? (row.errors as unknown as ImportRowError[]) : [],
    summary: (row.summary as unknown as ImportSummary) ?? null,
  };
}
