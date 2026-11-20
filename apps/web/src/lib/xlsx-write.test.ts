// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";

import { xlsxToCsv } from "./xlsx";
import { buildXlsx } from "./xlsx-write";

/**
 * The workbook writer, read back by the app's own reader (./xlsx.ts): every cell survives as text
 * -- an ID with leading zeros, Arabic, characters XML escapes -- and the sheet is a valid package.
 */

describe("buildXlsx", () => {
  test("round-trips through the reader, every cell as text", () => {
    const bytes = buildXlsx({
      name: "Students",
      rows: [
        ["Name", "Studafy ID", "Setup code"],
        ["Amina Tazi", "STU-0007", "0042-9A7F"],
        ['O\'Brien & "Sons" <x>', "TCH-12", "00123"],
        ["ليلى صالح", "PAR-3", "A1"],
      ],
    });
    expect(xlsxToCsv(bytes).trim().split("\n")).toEqual([
      "Name,Studafy ID,Setup code",
      "Amina Tazi,STU-0007,0042-9A7F",
      '"O\'Brien & ""Sons"" <x>",TCH-12,00123',
      "ليلى صالح,PAR-3,A1",
    ]);
  });

  test("a bold, frozen header; right to left on request; a tab name Excel accepts", () => {
    const files = unzipSync(
      buildXlsx({
        name: "Login slips: Students [2026/27]",
        rows: [["A"], ["b"]],
        rightToLeft: true,
      }),
    );
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">');
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain('name="Login slips  Students  2026 27"');
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  test("characters XML does not allow are dropped, not written broken", () => {
    const bytes = buildXlsx({ name: "S", rows: [["a\u0001b\u0008c"]] });
    expect(xlsxToCsv(bytes).trim()).toBe("abc");
  });
});
