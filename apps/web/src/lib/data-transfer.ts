import { ApiError } from "@studafy/api-client";

import { buildCsv, parseCsv } from "./csv";

import type { CsvCell } from "./csv";

/**
 * Client-side table export and CSV import, shared by every list page. Export walks the same list
 * endpoint (and filters) the page already uses and serialises the rows to CSV; import parses a CSV,
 * validates each row against an {@link ImportSpec}, and creates the valid rows one by one through
 * the entity's existing create endpoint. Large server-side exports (audit log, attendance, finance
 * reports) keep their own async job flows — this is for the tables that have none.
 */

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Hard ceiling on one export, so a mis-filtered table can't page the API indefinitely. */
export const MAX_EXPORT_ROWS = 10_000;

export interface ExportColumn<TRow> {
  header: string;
  value: (row: TRow) => CsvCell;
}

export interface CollectedRows<TRow> {
  rows: TRow[];
  /** True when {@link MAX_EXPORT_ROWS} cut the export short. */
  truncated: boolean;
}

/** Wraps rows the page already holds in full (non-paginated lists). */
export function allRows<TRow>(rows: readonly TRow[]): CollectedRows<TRow> {
  return { rows: rows.slice(0, MAX_EXPORT_ROWS), truncated: rows.length > MAX_EXPORT_ROWS };
}

/** Exhausts a cursor-paginated list endpoint, following `nextCursor` until it runs out. */
export async function collectCursorPages<TRow>(
  fetchPage: (
    cursor: string | undefined,
  ) => Promise<{ items: readonly TRow[]; nextCursor?: string | null }>,
  maxRows: number = MAX_EXPORT_ROWS,
): Promise<CollectedRows<TRow>> {
  const rows: TRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && rows.length < maxRows);
  return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows || Boolean(cursor) };
}

/** Exhausts an offset/total-shaped list endpoint. Stops on a short or empty page as well as at
 * `total`, so a `total` that drifts while paging can't loop forever. */
export async function collectOffsetPages<TRow>(
  fetchPage: (offset: number) => Promise<{ items: readonly TRow[]; total: number }>,
  maxRows: number = MAX_EXPORT_ROWS,
): Promise<CollectedRows<TRow>> {
  const rows: TRow[] = [];
  let total = Infinity;
  while (rows.length < total && rows.length < maxRows) {
    const page = await fetchPage(rows.length);
    total = page.total;
    if (page.items.length === 0) break;
    rows.push(...page.items);
  }
  return { rows: rows.slice(0, maxRows), truncated: rows.length >= maxRows && total > maxRows };
}

export function buildExportCsv<TRow>(
  columns: readonly ExportColumn<TRow>[],
  rows: readonly TRow[],
): string {
  return buildCsv(
    columns.map((column) => column.header),
    rows.map((row) => columns.map((column) => column.value(row))),
  );
}

/** `students` → `students-2026-10-06.csv`, dated in the viewer's local time zone. */
export function exportFilename(base: string, date: Date = new Date()): string {
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return `${base}-${day}.csv`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Ceiling on one import file: rows are created one request at a time. */
export const MAX_IMPORT_ROWS = 1_000;

export type ImportFieldType = "text" | "email" | "date" | "time" | "number" | "integer" | "boolean";

export type ImportValue = string | number | boolean | null;

export interface ImportField {
  /** Column header expected in the file (and written to the template). */
  key: string;
  /** Translated name, used for preview headers and error messages. */
  label: string;
  required?: boolean;
  type?: ImportFieldType;
  /** Allowed values (compared case-insensitively; the canonical spelling is kept). */
  options?: readonly string[];
  maxLength?: number;
  /** Sample value written to the template's example row. */
  example?: string;
}

export interface ImportSpec<TRecord> {
  fields: readonly ImportField[];
  /** Template download name, without extension. */
  templateName: string;
  /** Builds the create payload from validated values; return error strings to reject the row. */
  toRecord: (values: Readonly<Record<string, ImportValue>>) => TRecord | { errors: string[] };
  create: (record: TRecord) => Promise<unknown>;
}

/** A validation failure, kept as an i18n key + params so the dialog renders it in the UI locale. */
export interface ImportIssue {
  code:
    | "required"
    | "invalidEmail"
    | "invalidDate"
    | "invalidTime"
    | "invalidNumber"
    | "invalidInteger"
    | "invalidBoolean"
    | "invalidOption"
    | "tooLong"
    | "custom";
  field?: string;
  params?: Record<string, string | number>;
  /** Already-translated text, for `custom` issues returned by {@link ImportSpec.toRecord}. */
  message?: string;
}

export interface PreparedRow<TRecord> {
  /** 1-based line number in the file, counting the header, so it matches a spreadsheet row. */
  line: number;
  raw: Record<string, string>;
  record: TRecord | null;
  issues: ImportIssue[];
}

export type PrepareResult<TRecord> =
  | { ok: true; rows: PreparedRow<TRecord>[]; ignoredColumns: string[] }
  | {
      ok: false;
      reason: "empty" | "missingColumns" | "tooManyRows";
      missingColumns?: string[];
      limit?: number;
    };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const TRUE_VALUES = new Set(["true", "yes", "1", "y"]);
const FALSE_VALUES = new Set(["false", "no", "0", "n"]);

function normaliseHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Converts one raw cell into a typed value, or the issue that rejects it. Blank → `null`. */
export function coerceImportValue(
  field: ImportField,
  raw: string,
): { value: ImportValue } | { issue: ImportIssue } {
  const value = raw.trim();
  const base = { field: field.label };
  if (value === "") {
    return field.required ? { issue: { code: "required", ...base } } : { value: null };
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return { issue: { code: "tooLong", ...base, params: { max: field.maxLength } } };
  }
  if (field.options) {
    const match = field.options.find((option) => option.toLowerCase() === value.toLowerCase());
    return match === undefined
      ? { issue: { code: "invalidOption", ...base, params: { options: field.options.join(", ") } } }
      : { value: match };
  }
  switch (field.type ?? "text") {
    case "email":
      return EMAIL.test(value)
        ? { value: value.toLowerCase() }
        : { issue: { code: "invalidEmail", ...base } };
    case "date":
      return isValidIsoDate(value) ? { value } : { issue: { code: "invalidDate", ...base } };
    case "time":
      return TIME.test(value) ? { value } : { issue: { code: "invalidTime", ...base } };
    case "number": {
      const number = Number(value);
      return value !== "" && Number.isFinite(number)
        ? { value: number }
        : { issue: { code: "invalidNumber", ...base } };
    }
    case "integer": {
      const number = Number(value);
      return Number.isInteger(number)
        ? { value: number }
        : { issue: { code: "invalidInteger", ...base } };
    }
    case "boolean": {
      const lower = value.toLowerCase();
      if (TRUE_VALUES.has(lower)) return { value: true };
      if (FALSE_VALUES.has(lower)) return { value: false };
      return { issue: { code: "invalidBoolean", ...base } };
    }
    default:
      return { value };
  }
}

/** Parses and validates a whole file against `spec`. Never calls the API. */
export function prepareImport<TRecord>(
  text: string,
  spec: Pick<ImportSpec<TRecord>, "fields" | "toRecord">,
  maxRows: number = MAX_IMPORT_ROWS,
): PrepareResult<TRecord> {
  const [header, ...body] = parseCsv(text);
  if (!header || body.length === 0) return { ok: false, reason: "empty" };
  if (body.length > maxRows) return { ok: false, reason: "tooManyRows", limit: maxRows };

  const headerIndex = new Map(header.map((name, index) => [normaliseHeader(name), index]));
  const columnIndex = new Map<string, number>();
  for (const field of spec.fields) {
    const index =
      headerIndex.get(normaliseHeader(field.key)) ?? headerIndex.get(normaliseHeader(field.label));
    if (index !== undefined) columnIndex.set(field.key, index);
  }
  const missingColumns = spec.fields
    .filter((field) => field.required && !columnIndex.has(field.key))
    .map((field) => field.key);
  if (missingColumns.length > 0) return { ok: false, reason: "missingColumns", missingColumns };

  const usedIndexes = new Set(columnIndex.values());
  const ignoredColumns = header.filter(
    (name, index) => name.trim() !== "" && !usedIndexes.has(index),
  );

  const rows = body.map((cells, rowIndex): PreparedRow<TRecord> => {
    const raw: Record<string, string> = {};
    const values: Record<string, ImportValue> = {};
    const issues: ImportIssue[] = [];
    for (const field of spec.fields) {
      const index = columnIndex.get(field.key);
      const cell = index === undefined ? "" : (cells.at(index) ?? "");
      raw[field.key] = cell;
      const result = coerceImportValue(field, cell);
      if ("issue" in result) issues.push(result.issue);
      else values[field.key] = result.value;
    }
    let record: TRecord | null = null;
    if (issues.length === 0) {
      const built = spec.toRecord(values);
      if (
        built !== null &&
        typeof built === "object" &&
        "errors" in built &&
        Array.isArray(built.errors)
      ) {
        issues.push(...built.errors.map((message): ImportIssue => ({ code: "custom", message })));
      } else {
        record = built as TRecord;
      }
    }
    return { line: rowIndex + 2, raw, record, issues };
  });
  return { ok: true, rows, ignoredColumns };
}

/** The template: header row plus one example row built from each field's `example`. */
export function buildImportTemplate(fields: readonly ImportField[]): string {
  return buildCsv(
    fields.map((field) => field.key),
    [fields.map((field) => field.example ?? "")],
  );
}

export interface ImportRowResult {
  line: number;
  ok: boolean;
  error?: string;
}

/** Best human-readable reason for a failed create call. */
export function importErrorMessage(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.detail ?? error.title;
  if (error instanceof Error && error.message) return error.message;
  return undefined;
}

/**
 * Creates each valid row through `create`, a few at a time. A failed row is recorded and the rest
 * continue — the existing create endpoints are per-record, so the import is not atomic and the
 * result report says exactly which lines landed. Stops early (remaining rows unattempted) when
 * `signal` aborts.
 */
export async function runImport<TRecord>(
  rows: readonly PreparedRow<TRecord>[],
  create: (record: TRecord) => Promise<unknown>,
  options: { concurrency?: number; onProgress?: (done: number) => void; signal?: AbortSignal } = {},
): Promise<ImportRowResult[]> {
  const queue = rows.filter(
    (row): row is PreparedRow<TRecord> & { record: TRecord } => row.record !== null,
  );
  const results: ImportRowResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < queue.length && !options.signal?.aborted) {
      const row = queue.at(next);
      next += 1;
      if (!row) break;
      try {
        await create(row.record);
        results.push({ line: row.line, ok: true });
      } catch (error) {
        results.push({ line: row.line, ok: false, error: importErrorMessage(error) });
      }
      options.onProgress?.(results.length);
    }
  };
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, queue.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.sort((a, b) => a.line - b.line);
}
