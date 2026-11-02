import { normalizeRecordValue } from "@studafy/records/browser";

import { parseCsv } from "./csv";
import {
  REQUIRED_STUDENT_IMPORT_FIELDS,
  STUDENT_IMPORT_FIELD_DEFINITIONS,
  STUDENT_IMPORT_FIELDS,
} from "./fields";
import { toStudentImportRecord } from "./record";

import type { ImportRecordField, StudentImportField } from "./fields";
import type { StudentImportIssue, StudentImportRecord, StudentImportValues } from "./record";
import type { RecordValue, RecordValueError } from "@studafy/records/browser";

/**
 * Import field -> the source header it is read from. Unmapped optional fields are simply absent.
 * `records` maps a student record template field id to its header, the same way.
 */
export type ColumnMapping = Partial<Record<StudentImportField, string>> & {
  records?: Record<string, string>;
};

/** How a rejected template cell is described: the rule broken, never the value. */
const RECORD_VALUE_MESSAGES: Record<RecordValueError, string> = {
  RECORD_VALUE_WRONG_TYPE: "Not a valid answer for this field.",
  RECORD_VALUE_TOO_LONG: "Too long.",
  RECORD_VALUE_INVALID_NUMBER: "Not a number.",
  RECORD_VALUE_INVALID_DATE: "Use the YYYY-MM-DD format.",
  RECORD_VALUE_INVALID_CHOICE: "Not one of this field's choices.",
  RECORD_VALUE_INVALID_PHONE: "Not a valid phone number.",
  RECORD_VALUE_INVALID_EMAIL: "Not a valid email address.",
  RECORD_VALUE_DOCUMENT_FIELD: "Document fields cannot be imported.",
};

/** The issue `field` for a template column: `record:<field id>`. */
export function recordIssueField(fieldId: string): string {
  return `record:${fieldId}`;
}

/** One data line, raw cells keyed by the file's own header text. */
export interface SourceRow {
  line_number: number;
  source: Record<string, string>;
}

export interface CsvSource {
  /** 1-based line the header row was found on. */
  header_line: number;
  headers: string[];
  rows: SourceRow[];
}

export interface StagedRow extends SourceRow {
  record: StudentImportRecord | null;
}

export interface StagedRows {
  rows: StagedRow[];
  /** Mapping problems (at `header_line`) or, when the mapping is sound, per-line problems. */
  issues: StudentImportIssue[];
}

/** How many leading lines are searched for the header row. Exports often carry a title or a
 * "generated on" line above it; a header further down than this is not a header. */
const HEADER_SCAN_LINES = 10;

const ALIAS_INDEX: ReadonlyMap<string, StudentImportField> = new Map(
  STUDENT_IMPORT_FIELDS.flatMap((field) =>
    [field, ...STUDENT_IMPORT_FIELD_DEFINITIONS[field].aliases].map(
      (alias) => [normalizeHeader(alias), field] as const,
    ),
  ),
);

/** Case-, spacing- and punctuation-insensitive header key: "Student ID #" -> "studentid". Letters
 * and digits of any script are kept, so Arabic headers compare the same way. */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Parse a CSV and locate its header row: the line, among the first few, whose cells name the most
 * known import fields. Ties go to the earliest line; with no recognisable header at all the first
 * line is used, and mapping validation then reports what is unmapped.
 *
 * Blank header cells become "Column N" and repeated ones get " (2)", " (3)" so every source column
 * has a distinct key and can still be mapped.
 */
export function readCsvSource(raw: string): CsvSource {
  const records = parseCsv(raw);
  if (records.length === 0) return { header_line: 1, headers: [], rows: [] };

  let headerIndex = 0;
  let bestScore = 0;
  for (let i = 0; i < Math.min(records.length, HEADER_SCAN_LINES); i++) {
    const score = recognisedFields(records[i]!.cells).size;
    if (score > bestScore) {
      bestScore = score;
      headerIndex = i;
    }
  }

  const headers = uniqueHeaders(records[headerIndex]!.cells);
  // Object.fromEntries, not assignment: a header is arbitrary file content, and assigning a key
  // spelled "__proto__" would set the prototype instead of storing the column.
  const rows = records.slice(headerIndex + 1).map((record) => ({
    line_number: record.line,
    source: Object.fromEntries(
      headers.map((header, column) => [header, record.cells[column]?.trim() ?? ""]),
    ),
  }));

  return { header_line: records[headerIndex]!.line, headers, rows };
}

/**
 * Map each field to the first unclaimed header that spells it (or one of its aliases), then each
 * importable template field to an unclaimed header spelling its English or Arabic label.
 */
export function suggestColumnMapping(
  headers: readonly string[],
  recordFields: readonly ImportRecordField[] = [],
): ColumnMapping {
  const mapping: ColumnMapping = {};
  const claimed = new Set<string>();
  for (const header of headers) {
    const field = ALIAS_INDEX.get(normalizeHeader(header));
    if (field && mapping[field] === undefined) {
      mapping[field] = header;
      claimed.add(header);
    }
  }
  const records: Record<string, string> = {};
  for (const field of recordFields) {
    if (field.field_type === "document") continue;
    const labels = new Set([normalizeHeader(field.label_en), normalizeHeader(field.label_ar)]);
    const header = headers.find((h) => !claimed.has(h) && labels.has(normalizeHeader(h)));
    if (header) {
      records[field.id] = header;
      claimed.add(header);
    }
  }
  if (Object.keys(records).length > 0) mapping.records = records;
  return mapping;
}

/** Problems that make `mapping` unusable against `headers`, reported at the header line. */
export function validateColumnMapping(
  mapping: ColumnMapping,
  headers: readonly string[],
  headerLine: number,
  recordFields: readonly ImportRecordField[] = [],
): StudentImportIssue[] {
  const issues: StudentImportIssue[] = [];
  const byKey = new Map(headers.map((header) => [normalizeHeader(header), header]));
  // Header key -> what claimed it: an import field name, or a template field's English label.
  const claimedBy = new Map<string, string>();

  for (const field of REQUIRED_STUDENT_IMPORT_FIELDS) {
    if (mapping[field] === undefined) {
      issues.push({ line: headerLine, field, message: `Map a column to "${field}".` });
    }
  }

  for (const field of STUDENT_IMPORT_FIELDS) {
    const header = mapping[field];
    if (header === undefined) continue;
    const key = normalizeHeader(header);
    if (!byKey.has(key)) {
      issues.push({ line: headerLine, field, message: `Column "${header}" is not in this file.` });
      continue;
    }
    const other = claimedBy.get(key);
    if (other) {
      issues.push({
        line: headerLine,
        field,
        message: `Column "${header}" is already mapped to "${other}".`,
      });
      continue;
    }
    claimedBy.set(key, field);
  }

  const known = new Map(recordFields.map((field) => [field.id, field]));
  for (const [fieldId, header] of Object.entries(mapping.records ?? {})) {
    const field = known.get(fieldId);
    const issueField = recordIssueField(fieldId);
    if (!field) {
      issues.push({
        line: headerLine,
        field: issueField,
        message: "This record field is not on the published student form.",
      });
      continue;
    }
    if (field.field_type === "document") {
      issues.push({
        line: headerLine,
        field: issueField,
        message: `"${field.label_en}" is a document field: upload its files on the Records tab.`,
      });
      continue;
    }
    const key = normalizeHeader(header);
    if (!byKey.has(key)) {
      issues.push({
        line: headerLine,
        field: issueField,
        message: `Column "${header}" is not in this file.`,
      });
      continue;
    }
    const other = claimedBy.get(key);
    if (other) {
      issues.push({
        line: headerLine,
        field: issueField,
        message: `Column "${header}" is already mapped to "${other}".`,
      });
      continue;
    }
    claimedBy.set(key, field.label_en);
  }

  return issues;
}

/**
 * Apply `mapping` to staged source rows and validate each line.
 *
 * An unusable mapping stages every line with no record and reports only the mapping problems:
 * per-line errors against a wrong mapping are noise, and the admin's next step is to fix the mapping.
 */
export function stageRows(
  source: CsvSource,
  mapping: ColumnMapping,
  recordFields: readonly ImportRecordField[] = [],
): StagedRows {
  const mappingIssues = validateColumnMapping(
    mapping,
    source.headers,
    source.header_line,
    recordFields,
  );
  if (mappingIssues.length > 0) {
    return { rows: source.rows.map((row) => ({ ...row, record: null })), issues: mappingIssues };
  }

  const byKey = new Map(source.headers.map((header) => [normalizeHeader(header), header]));
  const columns = STUDENT_IMPORT_FIELDS.flatMap((field) => {
    const header = mapping[field];
    return header === undefined ? [] : [[field, byKey.get(normalizeHeader(header))!] as const];
  });

  const fieldsById = new Map(recordFields.map((field) => [field.id, field]));
  const recordColumns = Object.entries(mapping.records ?? {}).map(
    ([fieldId, header]) => [fieldsById.get(fieldId)!, byKey.get(normalizeHeader(header))!] as const,
  );

  const issues: StudentImportIssue[] = [];
  const rows = source.rows.map((row) => {
    const values: StudentImportValues = {};
    for (const [field, header] of columns) values[field] = row.source[header] || null;
    const result = toStudentImportRecord(row.line_number, values);

    const records: Record<string, RecordValue> = {};
    const recordIssues: StudentImportIssue[] = [];
    for (const [field, header] of recordColumns) {
      const normalized = normalizeRecordValue(field, row.source[header] ?? "");
      if (!normalized.ok) {
        // The field and the rule, never the cell: a rejected passport number must not land in the
        // import's stored errors (docs/modules/student-records.md "CSV import").
        recordIssues.push({
          line: row.line_number,
          field: recordIssueField(field.id),
          message: `"${field.label_en}": ${RECORD_VALUE_MESSAGES[normalized.error]}`,
        });
      } else if (normalized.value !== null) {
        records[field.id] = normalized.value;
      }
    }

    issues.push(...result.issues, ...recordIssues);
    if (!result.record || recordIssues.length > 0) return { ...row, record: null };
    const record = recordColumns.length > 0 ? { ...result.record, records } : result.record;
    return { ...row, record };
  });

  return { rows, issues };
}

function recognisedFields(cells: readonly string[]): Set<StudentImportField> {
  const fields = new Set<StudentImportField>();
  for (const cell of cells) {
    const field = ALIAS_INDEX.get(normalizeHeader(cell));
    if (field) fields.add(field);
  }
  return fields;
}

function uniqueHeaders(cells: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((cell, column) => {
    const base = cell.trim() || `Column ${column + 1}`;
    const key = normalizeHeader(base) || base;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}
