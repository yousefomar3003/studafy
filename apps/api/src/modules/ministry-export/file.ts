/**
 * The export file itself: the rows @studafy/grading-engine laid out, written as CSV or XLSX.
 *
 * CSV: RFC 4180 with CRLF line ends, every cell through csvCell (formula-safe, QA-063), optionally
 * preceded by a UTF-8 byte-order mark so Excel reads Arabic. XLSX: one "Results" sheet, the heading
 * row bold; numeric columns hold numbers, every other column is text-formatted so IDs keep their
 * leading zeros. exceljs is loaded on first use, as for the import template.
 */

import { csvCell } from "@studafy/sanitize";

import { XLSX_MEDIA_TYPE } from "./schemas";

import type { MinistryExportEncoding, MinistryExportFileFormat } from "@studafy/grading-engine";

/** U+FEFF, so spreadsheet apps read the Arabic as UTF-8. */
const UTF8_BOM = String.fromCharCode(0xfeff);

export interface ExportTable {
  header: readonly string[];
  rows: readonly (readonly string[])[];
  numericColumns: readonly boolean[];
}

export function renderCsv(table: ExportTable, encoding: MinistryExportEncoding): string {
  const lines = [table.header, ...table.rows].map((row) =>
    row.map((cell) => csvCell(cell)).join(","),
  );
  return `${encoding === "utf8_bom" ? UTF8_BOM : ""}${lines.join("\r\n")}\r\n`;
}

export async function renderXlsx(table: ExportTable, generatedAt: Date): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Studafy";
  workbook.created = generatedAt;
  workbook.modified = generatedAt;
  const sheet = workbook.addWorksheet("Results");
  table.header.forEach((header, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = Math.min(Math.max(header.length + 2, 12), 40);
    if (!table.numericColumns[index]) column.numFmt = "@";
  });
  const headerRow = sheet.addRow([...table.header]);
  headerRow.font = { bold: true };
  for (const row of table.rows) {
    sheet.addRow(
      row.map((cell, index) =>
        table.numericColumns[index] && cell !== "" && Number.isFinite(Number(cell))
          ? Number(cell)
          : cell,
      ),
    );
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export function contentTypeFor(format: MinistryExportFileFormat): string {
  return format === "xlsx" ? XLSX_MEDIA_TYPE : "text/csv; charset=utf-8";
}

/**
 * An ASCII file name from the template's name and the period: "jordan-moe-2026-2027-term-1.csv".
 * Arabic and other characters a header cannot carry are dropped; "ministry-export" is the fallback.
 */
export function exportFileName(
  templateName: string,
  period: readonly string[],
  format: MinistryExportFileFormat,
): string {
  const slug = [templateName, ...period]
    .map((part) =>
      part
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter((part) => part !== "")
    .join("-")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return `${slug === "" ? "ministry-export" : slug}.${format}`;
}
