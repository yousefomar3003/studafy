/**
 * Writes a one-sheet Excel workbook (.xlsx) in the browser, for data that exists only in the page --
 * such as login slips, whose setup codes the server never keeps (it stores just a hash), so a
 * server-side export is impossible.
 *
 * Deliberately small, the counterpart of ./xlsx.ts's reader: every cell is text (an inline string,
 * so a member ID or code is never read as a number or a date), the first row is bold and frozen,
 * columns are sized to their content, and a right-to-left sheet is supported. fflate zips it.
 */

import { strToU8, zipSync } from "fflate";

export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface XlsxSheet {
  /** The sheet's tab name; trimmed to Excel's 31 characters, without the characters it refuses. */
  name: string;
  /** The header row, then the data rows. Every cell is written as text. */
  rows: readonly (readonly string[])[];
  /** Lay the sheet out right to left (Arabic). */
  rightToLeft?: boolean;
}

/** Whether XML 1.0 allows a character: not a C0 control other than tab, newline and return. */
function allowedInXml(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x20
    ? code !== 0xfffe && code !== 0xffff
    : code === 0x09 || code === 0x0a || code === 0x0d;
}

function escapeXml(text: string): string {
  return text
    .split("")
    .filter(allowedInXml)
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "A", "B", ... "Z", "AA", ... for a 0-based column index. */
function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function sheetName(name: string): string {
  const cleaned = name
    .replace(/[\\/?*[\]:]/g, " ")
    .trim()
    .slice(0, 31);
  return cleaned === "" ? "Sheet1" : cleaned;
}

function sheetXml(sheet: XlsxSheet): string {
  const width = Math.max(0, ...sheet.rows.map((row) => row.length));
  const cols = Array.from({ length: width }, (_, c) => {
    const longest = Math.max(4, ...sheet.rows.map((row) => (row.at(c) ?? "").length));
    return `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, longest + 2)}" customWidth="1"/>`;
  }).join("");
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const style = r === 0 ? ' s="1"' : "";
          return `<c r="${columnName(c)}${r + 1}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const rtl = sheet.rightToLeft ? ' rightToLeft="1"' : "";
  const freeze =
    sheet.rows.length > 1
      ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetViews><sheetView workbookViewId="0"${rtl}>${freeze}</sheetView></sheetViews>` +
    (width > 0 ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${rows}</sheetData>` +
    "</worksheet>"
  );
}

/** The workbook's bytes: one sheet, every cell text, the header row bold and frozen. */
export function buildXlsx(sheet: XlsxSheet): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ),
    "xl/workbook.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${escapeXml(sheetName(sheet.name))}" sheetId="1" r:id="rId1"/></sheets>` +
        "</workbook>",
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        "</Relationships>",
    ),
    "xl/styles.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
        '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        "</styleSheet>",
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml(sheet)),
  };
  return zipSync(files);
}

/** Save `bytes` as `filename` from the page (a download, no server round trip). */
export function downloadXlsx(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: XLSX_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
