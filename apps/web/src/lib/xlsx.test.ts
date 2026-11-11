// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";

import { XlsxReadError, xlsxToCsv } from "./xlsx";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A minimal workbook: sheets by name -> sheet XML body (the `<row>`s). */
function workbook(sheets: Record<string, string>, extra: Record<string, string> = {}): Uint8Array {
  const names = Object.keys(sheets);
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(
      `<workbook ${NS} ${REL_NS}><sheets>${names
        .map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml" Type="worksheet"/>`,
        )
        .join("")}</Relationships>`,
    ),
  };
  names.forEach((name, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<worksheet ${NS}><sheetData>${sheets[name]}</sheetData></worksheet>`,
    );
  });
  for (const [path, xml] of Object.entries(extra)) files[path] = strToU8(xml);
  return zipSync(files);
}

describe("xlsxToCsv", () => {
  test("reads shared, inline and rich strings, numbers and dates, keeping row numbers", () => {
    const bytes = workbook(
      {
        Students: [
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>',
          // C2 is a date serial in a date style; B2 an inline string with a comma.
          '<row r="2"><c r="A2"><v>1001</v></c><c r="B2" t="inlineStr"><is><t>Hassan, Ali</t></is></c><c r="C2" s="1"><v>42444</v></c></row>',
          // Row 3 is missing entirely; row 4 skips column B.
          '<row r="4"><c r="A4" t="s"><v>3</v></c><c r="C4" t="str"><v>2018-09-02</v></c></row>',
        ].join(""),
      },
      {
        "xl/sharedStrings.xml": `<sst ${NS}><si><t>رقم الطالب</t></si><si><t>Name</t></si><si><t>Date of birth</t></si><si><r><t>ADM</t></r><r><t>-002</t></r></si></sst>`,
        "xl/styles.xml": `<styleSheet ${NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      },
    );

    expect(xlsxToCsv(bytes)).toBe(
      [
        "رقم الطالب,Name,Date of birth",
        '1001,"Hassan, Ali",2016-03-15',
        "",
        "ADM-002,,2018-09-02",
        "",
      ].join("\n"),
    );
  });

  test("reads the Students sheet when it is not the first", () => {
    const bytes = workbook({
      Instructions: '<row r="1"><c r="A1" t="inlineStr"><is><t>How to</t></is></c></row>',
      الطلاب: '<row r="1"><c r="A1" t="inlineStr"><is><t>First name</t></is></c></row>',
    });
    expect(xlsxToCsv(bytes)).toBe("First name\n");
  });

  test("a custom date format is read as a date, a plain number is not", () => {
    const bytes = workbook(
      {
        Sheet1: '<row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="0"><v>45000</v></c></row>',
      },
      {
        "xl/styles.xml": `<styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
      },
    );
    expect(xlsxToCsv(bytes)).toBe("2023-03-15,45000\n");
  });

  test("refuses a file that is not a workbook", () => {
    expect(() => xlsxToCsv(strToU8("admission_number,first_name\n"))).toThrow(XlsxReadError);
    expect(() => xlsxToCsv(zipSync({ "hello.txt": strToU8("hi") }))).toThrow(XlsxReadError);
  });

  test("refuses a workbook claiming more than the size cap, before inflating it", () => {
    const bytes = workbook({ Sheet1: '<row r="1"><c r="A1"><v>1</v></c></row>' });
    // Patch the central directory's uncompressed size of every entry to 2 GiB.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length - 4; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 0x80000000, true);
    }
    let error: unknown;
    try {
      xlsxToCsv(bytes);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(XlsxReadError);
    expect((error as XlsxReadError).reason).toBe("too_large");
  });
});
