import type { FinanceReportResponse, ReportColumn } from "../queries";

/**
 * Generic "render every column ERPNext sent back" support for the report center's preview grid.
 * `finance/queries.ts` only exports narrow, report-specific extractors (`agingBuckets`,
 * `overdueInstallments`, …) for the dashboard tiles — this is the report center's own generic
 * counterpart, kept feature-local rather than added to that shared file for the same "each feature
 * folder owns its own data-fetching file" reason `StudentPickerField`'s doc comment gives.
 */

function isReportColumn(value: unknown): value is ReportColumn {
  return value !== null && typeof value === "object";
}

/** Every column ERPNext described, in display order. Not every array entry is necessarily a
 * well-formed column object — anything else is dropped rather than rendered as a guess. */
export function reportColumns(report: FinanceReportResponse): ReportColumn[] {
  return report.columns.filter(isReportColumn);
}

/** A report row's raw value for one column. ERPNext query reports return rows either positionally
 * (array, matched by column order) or by fieldname (dict) depending on the report's own
 * implementation — both are read the same way here, mirroring `finance/queries.ts`'s own
 * `cellValue`. */
function rawCellValue(row: unknown, column: ReportColumn, columnIndex: number): unknown {
  if (Array.isArray(row)) {
    // `columnIndex` is drawn only from this report's own column list, never external input — the
    // same bounded-key shape `finance/queries.ts`'s own `cellValue` documents this rule for.
    // eslint-disable-next-line security/detect-object-injection
    return row[columnIndex];
  }
  if (row !== null && typeof row === "object") {
    const key = column.fieldname ?? String(columnIndex);
    // `key` comes from this report's own column list, never external input — same rule as above.
    // eslint-disable-next-line security/detect-object-injection
    return (row as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * The display string for one cell. Currency columns prefer the API's own `currency_display`
 * string (JOD's fixed 3-decimal convention, already formatted server-side) over formatting the raw
 * number again client-side; every other column falls back to the raw value's string form, and a
 * missing value renders as an em dash rather than "undefined" or a blank cell that reads as an
 * error.
 */
export function cellDisplay(
  report: FinanceReportResponse,
  rowIndex: number,
  column: ReportColumn,
  columnIndex: number,
): string {
  if (column.fieldtype === "Currency" && column.fieldname) {
    // eslint-disable-next-line security/detect-object-injection -- `rowIndex` iterates this report's own `rows`, `fieldname` is drawn from its own `columns`
    const formatted = report.presentation.currency_display[rowIndex]?.[column.fieldname];
    if (formatted) return formatted;
  }
  // eslint-disable-next-line security/detect-object-injection -- `rowIndex` iterates this report's own `rows`
  const raw = rawCellValue(report.rows[rowIndex], column, columnIndex);
  if (raw === null || raw === undefined || raw === "") return "—";
  return String(raw);
}

/** Right-aligns numeric-shaped columns; everything else reads left-to-right (or right-to-left,
 * under the report's own `dir`) like text. */
export function columnAlign(column: ReportColumn): "end" | "start" {
  return column.fieldtype === "Currency" ||
    column.fieldtype === "Int" ||
    column.fieldtype === "Float"
    ? "end"
    : "start";
}
