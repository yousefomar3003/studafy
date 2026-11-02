import type { components } from "@studafy/api-client";

type ImportRowError = components["schemas"]["ImportRowError"];

/**
 * There is no server-side "download the error report" endpoint (the dry-run response only carries
 * `errors` as JSON — see apps/api/src/modules/imports/schemas.ts's `ImportRecord`), so the
 * downloadable report is built client-side from that same array. Shared by the onboarding wizard's
 * student-import step and the admin students CSV import flow.
 */

/** Excel and Sheets evaluate a cell starting with one of these as a formula (CSV injection). */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Quotes a field only when it could otherwise be misread as a delimiter or newline, and neutralises
 * a leading formula character with an apostrophe so an exported value can't execute when the file
 * is opened in a spreadsheet. Plain negative numbers are left alone so amounts stay numeric.
 */
function csvField(value: string): string {
  const safe = FORMULA_PREFIX.test(value) && !Number.isFinite(Number(value)) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function buildImportErrorReportCsv(errors: readonly ImportRowError[]): string {
  const header = ["line", "field", "message"].join(",");
  const rows = errors.map((error) =>
    [String(error.line), csvField(error.field), csvField(error.message)].join(","),
  );
  return [header, ...rows].join("\r\n");
}

export type CsvCell = string | number | boolean | null | undefined;

/** Serialises a header row plus data rows as RFC 4180 CSV with CRLF line endings. */
export function buildCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header, ...rows].map((row) =>
    row.map((cell) => csvField(cell === null || cell === undefined ? "" : String(cell))).join(","),
  );
  return lines.join("\r\n");
}

/** UTF-8 byte-order mark: without it Excel opens a UTF-8 CSV as ANSI and mangles Arabic text. */
const UTF8_BOM = "\uFEFF";

/** Downloads `csv` as `filename`, BOM-prefixed so Excel detects the encoding. */
export function downloadCsv(filename: string, csv: string): void {
  downloadTextFile(filename, `${UTF8_BOM}${csv}`, "text/csv;charset=utf-8");
}

/**
 * Parses RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF, embedded newlines) into rows of
 * raw strings. A leading BOM and fully blank lines are dropped; no type coercion happens here.
 */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const endRow = () => {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    row = [];
    field = "";
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);
    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      endRow();
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Triggers a browser download of `content` as a file named `filename`. */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
