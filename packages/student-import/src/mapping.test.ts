// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { detectDelimiter, parseCsv } from "./csv";
import {
  normalizeHeader,
  readCsvSource,
  stageRows,
  suggestColumnMapping,
  validateColumnMapping,
} from "./mapping";
import { toStudentImportRecord } from "./record";

const TEMPLATE_HEADER =
  "admission_number,email,first_name,middle_name,last_name,preferred_name,date_of_birth,status,parent_email,parent_relationship";

describe("parseCsv", () => {
  test("handles quotes, escaped quotes, quoted delimiters and quoted line breaks", () => {
    const records = parseCsv('a,b,c\n"x, y","say ""hi""","line\nbreak"\n\nlast,,\n');
    expect(records).toEqual([
      { line: 1, cells: ["a", "b", "c"] },
      { line: 2, cells: ["x, y", 'say "hi"', "line\nbreak"] },
      { line: 5, cells: ["last", "", ""] },
    ]);
  });

  test("strips a UTF-8 BOM, accepts CRLF and skips all-blank lines", () => {
    expect(parseCsv("﻿a,b\r\n,\r\n1,2")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 3, cells: ["1", "2"] },
    ]);
  });

  test("detects semicolon and tab delimiters from the first line", () => {
    expect(detectDelimiter("a;b;c\n1,5;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n")).toBe("\t");
    expect(detectDelimiter('"a;b",c\n')).toBe(",");
    expect(parseCsv("a;b\n1;2")[1]!.cells).toEqual(["1", "2"]);
  });
});

describe("header detection and suggested mapping", () => {
  test("finds the header below title lines and maps renamed, reordered headers", () => {
    const source = readCsvSource(
      [
        "Student export,,,",
        "Generated 2026-09-01,,,",
        "Surname,Given Name,Student ID,E-mail,DOB,Guardian Email,Relationship",
        "Doe,Jane,ADM-1,jane@example.edu,2010-03-15,mum@example.edu,Mother",
      ].join("\n"),
    );

    expect(source.header_line).toBe(3);
    expect(source.rows).toEqual([
      {
        line_number: 4,
        source: {
          Surname: "Doe",
          "Given Name": "Jane",
          "Student ID": "ADM-1",
          "E-mail": "jane@example.edu",
          DOB: "2010-03-15",
          "Guardian Email": "mum@example.edu",
          Relationship: "Mother",
        },
      },
    ]);
    expect(suggestColumnMapping(source.headers)).toEqual({
      last_name: "Surname",
      first_name: "Given Name",
      admission_number: "Student ID",
      email: "E-mail",
      date_of_birth: "DOB",
      parent_email: "Guardian Email",
      parent_relationship: "Relationship",
    });
  });

  test("the fixed template maps onto itself", () => {
    const { headers } = readCsvSource(`${TEMPLATE_HEADER}\n`);
    const mapping = suggestColumnMapping(headers);
    for (const header of headers) expect(mapping[header as keyof typeof mapping]).toBe(header);
  });

  test("names blank header cells and disambiguates repeated ones", () => {
    const { headers } = readCsvSource("Email,,email,Notes\n");
    expect(headers).toEqual(["Email", "Column 2", "email (2)", "Notes"]);
  });

  test("a header spelled __proto__ is stored as a column, not as the prototype", () => {
    const { rows } = readCsvSource("__proto__,b\nx,y\n");
    expect(Object.keys(rows[0]!.source)).toEqual(["__proto__", "b"]);
    expect(Object.getPrototypeOf(rows[0]!.source)).toBe(Object.prototype);
  });

  test("normalizeHeader ignores case, spacing and punctuation in any script", () => {
    expect(normalizeHeader(" Student ID # ")).toBe("studentid");
    expect(normalizeHeader("رقم القيد")).toBe("رقمالقيد");
  });
});

describe("validateColumnMapping", () => {
  const headers = ["ID", "Mail", "First", "Last"];

  test("accepts a complete mapping, matching headers loosely", () => {
    expect(
      validateColumnMapping(
        { admission_number: "id", email: "MAIL", first_name: "First", last_name: "Last" },
        headers,
        1,
      ),
    ).toEqual([]);
  });

  test("reports unmapped required fields, missing columns and double-mapped columns", () => {
    const issues = validateColumnMapping(
      { admission_number: "ID", email: "ID", first_name: "Given" },
      headers,
      2,
    );
    expect(issues).toEqual([
      { line: 2, field: "last_name", message: 'Map a column to "last_name".' },
      { line: 2, field: "email", message: 'Column "ID" is already mapped to "admission_number".' },
      { line: 2, field: "first_name", message: 'Column "Given" is not in this file.' },
    ]);
  });
});

describe("stageRows", () => {
  const source = readCsvSource(
    [
      "ID,Mail,First,Last,Status,Parent,Relation",
      "A1,a1@example.edu,Ann,Lee,Enrolled,p1@example.edu,Step-Parent",
      "A2,not-an-email,Bob,,,p2@example.edu,",
    ].join("\n"),
  );
  const mapping = {
    admission_number: "ID",
    email: "Mail",
    first_name: "First",
    last_name: "Last",
    status: "Status",
    parent_email: "Parent",
    parent_relationship: "Relation",
  } as const;

  test("maps valid lines to records and reports invalid lines by their file line", () => {
    const staged = stageRows(source, mapping);

    expect(staged.rows[0]!.record).toEqual({
      admission_number: "A1",
      email: "a1@example.edu",
      first_name: "Ann",
      middle_name: null,
      last_name: "Lee",
      preferred_name: null,
      date_of_birth: null,
      status: "enrolled",
      parent_email: "p1@example.edu",
      parent_name: null,
      parent_relationship: "step_parent",
    });
    expect(staged.rows[1]!.record).toBeNull();
    expect(staged.issues.map((i) => [i.line, i.field])).toEqual([
      [3, "email"],
      [3, "last_name"],
      [3, "parent_relationship"],
    ]);
  });

  test("an unusable mapping stages raw rows only and reports just the mapping", () => {
    const staged = stageRows(source, { admission_number: "ID" });
    expect(staged.rows.every((row) => row.record === null && row.source.ID)).toBe(true);
    expect(staged.issues.every((issue) => issue.line === 1)).toBe(true);
  });
});

describe("toStudentImportRecord", () => {
  const base = { admission_number: "A1", email: "a@x.edu", first_name: "A", last_name: "B" };

  test("rejects non-ISO dates rather than guessing day/month order", () => {
    const result = toStudentImportRecord(2, { ...base, date_of_birth: "03/04/2010" });
    expect(result.issues).toEqual([
      { line: 2, field: "date_of_birth", message: "Use the YYYY-MM-DD format." },
    ]);
  });

  test("a parent email equal to the student's is rejected", () => {
    const result = toStudentImportRecord(2, {
      ...base,
      parent_email: "A@X.edu",
      parent_relationship: "mother",
    });
    expect(result.issues.map((i) => i.field)).toEqual(["parent_email"]);
  });

  test("parent details without a parent email are rejected", () => {
    const result = toStudentImportRecord(2, { ...base, parent_name: "Pat" });
    expect(result.issues.map((i) => i.field)).toEqual(["parent_email"]);
  });
});
