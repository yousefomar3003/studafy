/**
 * QA-063: one CSV cell writer for every export, safe against formula injection.
 *
 * The audit and finance exports quoted only `"`, `,` and line breaks, so a `User-Agent:
 * =HYPERLINK(...)` header or a display name starting with `=` became a live formula when an admin
 * opened the file in Excel. Text a spreadsheet would read as a formula is now prefixed with `'`.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { csvCell } from "./index";

describe("csvCell (QA-063)", () => {
  test("text starting with = + - @ tab or CR is neutralised", () => {
    expect(csvCell('=HYPERLINK("https://evil.example","x")')).toBe(
      `"'=HYPERLINK(""https://evil.example"",""x"")"`,
    );
    expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe(`"'\r=1"`);
  });

  test("numbers, including negative ones, stay numbers", () => {
    expect(csvCell(-125.5)).toBe("-125.5");
    expect(csvCell("-125.000")).toBe("-125.000");
    expect(csvCell("42")).toBe("42");
  });

  test("ordinary values are quoted only when needed", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell({ score: 93 })).toBe('"{""score"":93}"');
  });
});
