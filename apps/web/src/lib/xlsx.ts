/**
 * Reads an Excel workbook (.xlsx) in the browser and turns one sheet into CSV text, so a school can
 * upload the Excel template as they filled it in. The API only ever receives CSV: a hostile
 * workbook (a zip bomb, say) is unpacked here, in the uploader's own tab, never on a server.
 *
 * Deliberately small: fflate unzips, DOMParser reads the sheet XML. Only what the import needs is
 * read -- cell text, shared strings, numbers, booleans, formula results, and dates (a number in a
 * date-formatted cell becomes YYYY-MM-DD, the format the import accepts). Formatting, merged cells
 * and everything else are ignored.
 *
 * The sheet read is the one named like the template's (Students / الطلاب), else the first one.
 */

import { strFromU8, unzipSync } from "fflate";

/** Uncompressed bytes the reader will unpack in total: far above a 10,000-row roll, far below a
 * zip bomb. */
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const PREFERRED_SHEETS = ["students", "الطلاب"];

export class XlsxReadError extends Error {
  constructor(
    readonly reason: "not_xlsx" | "too_large" | "no_sheet",
    message: string,
  ) {
    super(message);
    this.name = "XlsxReadError";
  }
}

/** Whether `file` looks like an Excel workbook, by name or type. */
export function isXlsxFile(file: File): boolean {
  return (
    file.name.toLowerCase().endsWith(".xlsx") ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}

/** The workbook's chosen sheet as CSV text (RFC 4180 quoting, `\n` line ends). */
export function xlsxToCsv(bytes: Uint8Array): string {
  const files = unpack(bytes);
  const workbook = parseXml(files, "xl/workbook.xml");
  const rels = parseXml(files, "xl/_rels/workbook.xml.rels");

  const sheets = elements(workbook, "sheet").map((sheet) => ({
    name: sheet.getAttribute("name") ?? "",
    relId: sheet.getAttribute("r:id") ?? "",
  }));
  const chosen =
    sheets.find((sheet) => PREFERRED_SHEETS.includes(sheet.name.trim().toLowerCase())) ?? sheets[0];
  if (!chosen) throw new XlsxReadError("no_sheet", "The workbook has no sheets.");
  const target = elements(rels, "Relationship").find(
    (rel) => rel.getAttribute("Id") === chosen.relId,
  );
  const targetPath = target?.getAttribute("Target") ?? "";
  const sheetPath = targetPath.startsWith("/")
    ? targetPath.slice(1)
    : `xl/${targetPath.replace(/^\.\//, "")}`;
  if (!(sheetPath in files)) throw new XlsxReadError("no_sheet", "The sheet could not be found.");

  const sharedStrings =
    "xl/sharedStrings.xml" in files
      ? elements(parseXml(files, "xl/sharedStrings.xml"), "si").map(textOf)
      : [];
  const dateStyles =
    "xl/styles.xml" in files ? readDateStyles(parseXml(files, "xl/styles.xml")) : new Set<number>();

  const rows: string[][] = [];
  for (const row of elements(parseXml(files, sheetPath), "row")) {
    const rowNumber = Number(row.getAttribute("r")) || rows.length + 1;
    const cells: string[] = [];
    let next = 0;
    for (const cell of Array.from(row.children).filter((child) => child.localName === "c")) {
      const ref = cell.getAttribute("r");
      const column = ref ? columnIndex(ref) : next;
      cells[column] = cellText(cell, sharedStrings, dateStyles);
      next = column + 1;
    }
    // Rows Excel skipped (entirely empty) are kept as empty lines, so line numbers in the import's
    // error report match the row numbers the school sees in Excel.
    while (rows.length < rowNumber - 1) rows.push([]);
    rows.push(Array.from(cells, (value) => value ?? ""));
  }

  // Trailing empty rows (formatting left on blank rows) are dropped.
  while (rows.length > 0 && rows[rows.length - 1]!.every((value) => value === "")) rows.pop();
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + (rows.length ? "\n" : "");
}

function unpack(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (entry) => {
        // Only the parts this reader looks at are inflated, and their declared sizes are counted
        // before anything is: a workbook claiming more than the cap is refused unopened.
        const wanted =
          entry.name === "xl/workbook.xml" ||
          entry.name === "xl/_rels/workbook.xml.rels" ||
          entry.name === "xl/sharedStrings.xml" ||
          entry.name === "xl/styles.xml" ||
          entry.name.startsWith("xl/worksheets/");
        if (!wanted || entry.name.endsWith("/")) return false;
        total += entry.originalSize;
        if (total > MAX_UNCOMPRESSED_BYTES) {
          throw new XlsxReadError("too_large", "The workbook is too large to read.");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof XlsxReadError) throw error;
    throw new XlsxReadError("not_xlsx", "This file is not an Excel workbook.");
  }
  if (!("xl/workbook.xml" in files)) {
    throw new XlsxReadError("not_xlsx", "This file is not an Excel workbook.");
  }
  return files;
}

function parseXml(files: Record<string, Uint8Array>, path: string): Document {
  const bytes = files[path];
  if (!bytes) throw new XlsxReadError("not_xlsx", `Missing ${path}.`);
  return new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
}

/** Descendant elements by local name, whatever namespace prefix the writer used. */
function elements(root: Document | Element, localName: string): Element[] {
  const found: Element[] = [];
  const start = "documentElement" in root ? root.documentElement : root;
  if (!start) return found;
  const stack: Element[] = [start];
  while (stack.length > 0) {
    const element = stack.pop()!;
    if (element !== root && element.localName === localName) found.push(element);
    // Children pushed in reverse, so elements come out in document order.
    for (let i = element.children.length - 1; i >= 0; i--) stack.push(element.children[i]!);
  }
  return found;
}

/** All text of a shared or inline string: plain `<t>` or rich-text runs, phonetic hints skipped. */
function textOf(item: Element): string {
  return elements(item, "t")
    .filter((t) => t.parentElement?.localName !== "rPh")
    .map((t) => t.textContent ?? "")
    .join("");
}

/** 0-based column of a cell reference: "C7" -> 2, "AA1" -> 26. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** Built-in number formats that are dates (ECMA-376 18.8.30). */
const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Indexes of cell styles (`s`) whose number format shows a date. */
function readDateStyles(styles: Document): Set<number> {
  const custom = new Map<number, string>();
  for (const format of elements(styles, "numFmt")) {
    custom.set(Number(format.getAttribute("numFmtId")), format.getAttribute("formatCode") ?? "");
  }
  const isDate = (id: number): boolean => {
    if (BUILT_IN_DATE_FORMATS.has(id)) return true;
    const code = custom.get(id);
    if (!code) return false;
    // A date format names days, months or years outside quoted text and [colour] codes.
    const bare = code.replace(/"[^"]*"|\[[^\]]*]/g, "");
    return /[dy]/i.test(bare) || /m{3,}/i.test(bare);
  };
  const dateStyles = new Set<number>();
  const cellXfs = elements(styles, "cellXfs")[0];
  if (!cellXfs) return dateStyles;
  Array.from(cellXfs.children)
    .filter((child) => child.localName === "xf")
    .forEach((xf, index) => {
      if (isDate(Number(xf.getAttribute("numFmtId")))) dateStyles.add(index);
    });
  return dateStyles;
}

function cellText(
  cell: Element,
  sharedStrings: readonly string[],
  dateStyles: Set<number>,
): string {
  const type = cell.getAttribute("t") ?? "n";
  if (type === "inlineStr") {
    const inline = elements(cell, "is")[0];
    return inline ? textOf(inline).trim() : "";
  }
  const value = elements(cell, "v")[0]?.textContent ?? "";
  if (value === "") return "";
  switch (type) {
    case "s":
      return (sharedStrings[Number(value)] ?? "").trim();
    case "b":
      return value === "1" ? "TRUE" : "FALSE";
    case "e":
      return "";
    case "str":
      return value.trim();
    default: {
      const number = Number(value);
      if (!Number.isFinite(number)) return value;
      if (dateStyles.has(Number(cell.getAttribute("s")))) return serialToDate(number);
      // Whole numbers without Excel's float noise: 1001 not 1001.0000000002.
      return Number.isInteger(number) ? String(number) : String(Number(number.toPrecision(15)));
    }
  }
}

/** An Excel date serial (1900 system) as YYYY-MM-DD. */
function serialToDate(serial: number): string {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
