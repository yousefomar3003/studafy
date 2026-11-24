// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { contentTypeFor, exportFileName, renderCsv, renderXlsx } from "./file";

const TABLE = {
  header: ["الرقم الوطني", "Name", "Mark"],
  rows: [
    ["0991234567", "Haddad, Amal", "86.50"],
    ["=cmd", 'Say "hi"', ""],
  ],
  numericColumns: [false, false, true],
};

describe("renderCsv", () => {
  test("writes RFC 4180 rows with CRLF and formula-safe cells", () => {
    expect(renderCsv(TABLE, "utf8")).toBe(
      'الرقم الوطني,Name,Mark\r\n0991234567,"Haddad, Amal",86.50\r\n\'=cmd,"Say ""hi""",\r\n',
    );
  });

  test("starts with a byte-order mark only when asked", () => {
    expect(renderCsv(TABLE, "utf8_bom").charCodeAt(0)).toBe(0xfeff);
    expect(renderCsv(TABLE, "utf8").charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe("renderXlsx", () => {
  test("keeps IDs as text and marks as numbers", async () => {
    const bytes = await renderXlsx(TABLE, new Date("2026-11-24T00:00:00Z"));
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes.buffer as ArrayBuffer);
    const sheet = workbook.getWorksheet("Results")!;
    expect(sheet.getRow(1).getCell(1).value).toBe("الرقم الوطني");
    expect(sheet.getRow(1).font?.bold).toBe(true);
    expect(sheet.getRow(2).getCell(1).value).toBe("0991234567");
    expect(sheet.getRow(2).getCell(3).value).toBe(86.5);
    // A formula-looking text stays text: exceljs stores strings, never formulas.
    expect(sheet.getRow(3).getCell(1).value).toBe("=cmd");
    expect(sheet.getRow(3).getCell(3).value).toBe("");
  });
});

describe("file names", () => {
  test("are ASCII slugs of the template and period", () => {
    expect(exportFileName("Jordan MoE", ["2026-2027", "Term 1"], "csv")).toBe(
      "jordan-moe-2026-2027-term-1.csv",
    );
    expect(exportFileName("وزارة التربية", [], "xlsx")).toBe("ministry-export.xlsx");
    expect(contentTypeFor("csv")).toBe("text/csv; charset=utf-8");
    expect(contentTypeFor("xlsx")).toContain("spreadsheetml");
  });
});
