// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildImportErrorReportCsv } from "./csvErrorReport";

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
