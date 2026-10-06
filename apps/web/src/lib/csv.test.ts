// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildCsv, buildImportErrorReportCsv, parseCsv } from "./csv";

describe("buildImportErrorReportCsv", () => {
  test("renders a header row followed by one row per error", () => {
    const csv = buildImportErrorReportCsv([
      { line: 2, field: "email", message: "Invalid email address." },
      { line: 5, field: "admission_number", message: "Required." },
    ]);

    expect(csv).toBe(
      "line,field,message\r\n" +
        "2,email,Invalid email address.\r\n" +
        "5,admission_number,Required.",
    );
  });

  test("quotes a message containing a comma", () => {
    const csv = buildImportErrorReportCsv([
      { line: 1, field: "date_of_birth", message: "Invalid date, expected YYYY-MM-DD." },
    ]);

    expect(csv).toBe('line,field,message\r\n1,date_of_birth,"Invalid date, expected YYYY-MM-DD."');
  });

  test("escapes an embedded double quote by doubling it", () => {
    const csv = buildImportErrorReportCsv([
      { line: 1, field: "last_name", message: 'Contains a stray " character.' },
    ]);

    expect(csv).toContain('"Contains a stray "" character."');
  });

  test("returns just the header for an empty error list", () => {
    expect(buildImportErrorReportCsv([])).toBe("line,field,message");
  });
});

describe("buildCsv", () => {
  test("renders header and rows, blanking null and undefined", () => {
    expect(
      buildCsv(
        ["a", "b", "c"],
        [
          [1, null, true],
          ["x", undefined, "y"],
        ],
      ),
    ).toBe("a,b,c\r\n1,,true\r\nx,,y");
  });

  test("neutralises a leading formula character", () => {
    expect(buildCsv(["v"], [["=HYPERLINK(1)"], ["@cmd"], ["+1+1"]])).toBe(
      "v\r\n'=HYPERLINK(1)\r\n'@cmd\r\n'+1+1",
    );
  });

  test("leaves plain negative numbers numeric", () => {
    expect(buildCsv(["amount"], [["-12.50"], [-3]])).toBe("amount\r\n-12.50\r\n-3");
  });

  test("quotes fields containing commas, quotes, or newlines", () => {
    expect(buildCsv(["v"], [["a,b"], ['say "hi"'], ["line1\nline2"]])).toBe(
      'v\r\n"a,b"\r\n"say ""hi"""\r\n"line1\nline2"',
    );
  });
});

describe("parseCsv", () => {
  test("parses simple rows with CRLF or LF endings", () => {
    expect(parseCsv("a,b\r\n1,2\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("handles quoted fields with commas, doubled quotes, and newlines", () => {
    expect(parseCsv('name,note\n"Doe, Jane","said ""hi""\nthen left"')).toEqual([
      ["name", "note"],
      ["Doe, Jane", 'said "hi"\nthen left'],
    ]);
  });

  test("strips a BOM and skips blank lines", () => {
    expect(parseCsv("\uFEFFa,b\n\n1,2\n,\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("keeps trailing empty fields", () => {
    expect(parseCsv("a,b,c\n1,,")).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
    ]);
  });

  test("round-trips buildCsv output", () => {
    const rows = [["Doe, Jane", 'a "b"', "x\ny"]];
    expect(parseCsv(buildCsv(["n", "q", "m"], rows)).slice(1)).toEqual(rows);
  });
});
