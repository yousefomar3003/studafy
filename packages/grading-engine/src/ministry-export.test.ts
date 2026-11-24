// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  MINISTRY_EXPORT_EXAMPLES,
  applyValueMap,
  buildMinistryExport,
  formatExportNumber,
  ministryExportExample,
  validateMinistryExportTemplate,
} from "./index";

import type {
  MinistryExportColumnDefinition,
  MinistryExportSourceRow,
  MinistryExportTemplateDefinition,
} from "./index";

const column = (
  header: string,
  field: MinistryExportColumnDefinition["field"],
  extra: Partial<MinistryExportColumnDefinition> = {},
): MinistryExportColumnDefinition => ({
  header,
  field,
  constantValue: null,
  valueMap: [],
  ...extra,
});

const template = (
  overrides: Partial<MinistryExportTemplateDefinition> = {},
): MinistryExportTemplateDefinition => ({
  name: "Jordan MoE",
  target: "Jordan MoE",
  fileFormat: "csv",
  encoding: "utf8_bom",
  rowKind: "subject",
  decimalPlaces: 2,
  columns: [column("National ID", "national_id"), column("Mark", "mark")],
  ...overrides,
});

const row = (overrides: Partial<MinistryExportSourceRow> = {}): MinistryExportSourceRow => ({
  studentId: "stu-amal",
  nationalId: "9981234567",
  admissionNumber: "A-001",
  firstName: "Amal",
  middleName: "Khaled",
  lastName: "Haddad",
  dateOfBirth: "2010-03-15",
  gradeLevel: "Grade 10",
  section: "A",
  sectionId: "sec-a",
  academicYear: "2026-2027",
  term: "Term 1",
  subject: { id: "sub-math", code: "MATH", name: "Mathematics" },
  subjectMinistryCode: "101",
  status: "pass",
  mark: 86.456,
  maxMark: 100,
  percentage: 86.456,
  gradeLabel: "B+",
  gpa: 3.3,
  ...overrides,
});

describe("validateMinistryExportTemplate", () => {
  test("accepts every built-in example", () => {
    for (const example of MINISTRY_EXPORT_EXAMPLES) {
      expect(validateMinistryExportTemplate(example.template)).toEqual([]);
    }
  });

  test("needs a name, a column, valid decimals and unique headings", () => {
    const codes = validateMinistryExportTemplate(
      template({
        name: " ",
        decimalPlaces: 4,
        columns: [column("Mark", "mark"), column(" mark ", "percentage"), column("", "term")],
      }),
    ).map((issue) => issue.code);
    expect(codes).toEqual(["NAME_REQUIRED", "DECIMALS", "HEADER_DUPLICATE", "HEADER_REQUIRED"]);
    expect(validateMinistryExportTemplate(template({ columns: [] })).map((i) => i.code)).toEqual([
      "NO_COLUMNS",
    ]);
  });

  test("keeps subject fields to per-subject rows", () => {
    const issues = validateMinistryExportTemplate(
      template({ rowKind: "overall", columns: [column("Code", "subject_ministry_code")] }),
    );
    expect(issues.map((issue) => [issue.code, issue.ref])).toEqual([
      ["FIELD_NEEDS_SUBJECT_ROWS", "0"],
    ]);
  });

  test("a fixed-text column needs its text and takes no value map", () => {
    const codes = (extra: Partial<MinistryExportColumnDefinition>) =>
      validateMinistryExportTemplate(
        template({ columns: [column("School", "constant", extra)] }),
      ).map((issue) => issue.code);
    expect(codes({})).toEqual(["CONSTANT_REQUIRED"]);
    expect(codes({ constantValue: "SCH-7", valueMap: [{ from: "a", to: "b" }] })).toEqual([
      "CONSTANT_MAPPED",
    ]);
    expect(codes({ constantValue: "SCH-7" })).toEqual([]);
    expect(
      validateMinistryExportTemplate(
        template({ columns: [column("Mark", "mark", { constantValue: "x" })] }),
      ).map((issue) => issue.code),
    ).toEqual(["CONSTANT_UNEXPECTED"]);
  });

  test("a value map lists each of our values once", () => {
    const codes = validateMinistryExportTemplate(
      template({
        columns: [
          column("Result", "status", {
            valueMap: [
              { from: "pass", to: "1" },
              { from: " pass", to: "2" },
              { from: "", to: "3" },
            ],
          }),
        ],
      }),
    ).map((issue) => issue.code);
    expect(codes).toEqual(["VALUE_MAP_DUPLICATE", "VALUE_MAP_FROM"]);
  });
});

describe("formatting", () => {
  test("numbers carry the template's decimals, rounded half up", () => {
    expect(formatExportNumber(86.455, 2)).toBe("86.46");
    expect(formatExportNumber(1.005, 2)).toBe("1.01");
    expect(formatExportNumber(86.5, 0)).toBe("87");
    expect(formatExportNumber(90, 1)).toBe("90.0");
    expect(formatExportNumber(null, 2)).toBe("");
  });

  test("a value map translates exact values and leaves the rest", () => {
    const map = [
      { from: "pass", to: " ناجح " },
      { from: "B+", to: "3" },
    ];
    expect(applyValueMap("pass", map)).toBe("ناجح");
    expect(applyValueMap("B+", map)).toBe("3");
    expect(applyValueMap("Pass", map)).toBe("Pass");
    expect(applyValueMap("", map)).toBe("");
  });
});

describe("buildMinistryExport", () => {
  test("lays out each row in the template's column order", () => {
    const output = buildMinistryExport(
      template({
        decimalPlaces: 1,
        columns: [
          column("School", "constant", { constantValue: " 4412 " }),
          column("ID", "national_id"),
          column("No.", "admission_number"),
          column("Name", "full_name"),
          column("First", "first_name"),
          column("Middle", "middle_name"),
          column("Last", "last_name"),
          column("Born", "date_of_birth"),
          column("Grade", "grade_level"),
          column("Section", "section"),
          column("Year", "academic_year"),
          column("Term", "term"),
          column("Code", "subject_code"),
          column("Subject", "subject_name"),
          column("MoE code", "subject_ministry_code"),
          column("Mark", "mark"),
          column("Max", "max_mark"),
          column("%", "percentage"),
          column("Label", "grade_label", { valueMap: [{ from: "B+", to: "7" }] }),
          column("GPA", "gpa"),
          column("Result", "status", { valueMap: [{ from: "pass", to: "ناجح" }] }),
        ],
      }),
      [row()],
      { nationalIdSourceSet: true },
    );
    expect(output.header[0]).toBe("School");
    expect(output.rows).toEqual([
      [
        "4412",
        "9981234567",
        "A-001",
        "Amal Khaled Haddad",
        "Amal",
        "Khaled",
        "Haddad",
        "2010-03-15",
        "Grade 10",
        "A",
        "2026-2027",
        "Term 1",
        "MATH",
        "Mathematics",
        "101",
        "86.5",
        "100.0",
        "86.5",
        "7",
        "3.3",
        "ناجح",
      ],
    ]);
    // Numbers stay numbers in a spreadsheet unless the column maps them.
    expect(output.numericColumns.filter(Boolean)).toHaveLength(4);
    expect(output.numericColumns[18]).toBe(false);
    expect(output.issues).toEqual([]);
  });

  test("an annual result's term reads Annual, which a value map can rename", () => {
    const output = buildMinistryExport(
      template({
        rowKind: "overall",
        columns: [
          column("Term", "term"),
          column("Term (MoE)", "term", { valueMap: [{ from: "Annual", to: "3" }] }),
          column("Name", "full_name"),
          column("Mark", "mark"),
        ],
      }),
      [
        row({
          term: null,
          subject: null,
          subjectMinistryCode: null,
          middleName: null,
          mark: null,
          status: "promoted",
        }),
      ],
      { nationalIdSourceSet: false },
    );
    expect(output.rows).toEqual([["Annual", "3", "Amal Haddad", ""]]);
    expect(output.issues).toEqual([]);
  });

  test("reports students without a national ID and subjects without a ministry code", () => {
    const output = buildMinistryExport(
      template({
        columns: [column("ID", "national_id"), column("Code", "subject_ministry_code")],
      }),
      [
        row({ nationalId: null }),
        row({
          nationalId: "  ",
          subject: { id: "sub-art", code: "ART", name: "Art" },
          subjectMinistryCode: null,
        }),
        row({
          studentId: "stu-badr",
          subject: { id: "sub-art", code: "ART", name: "Art" },
          subjectMinistryCode: null,
        }),
      ],
      { nationalIdSourceSet: true },
    );
    expect(output.issues).toEqual([
      { code: "missing_national_id", count: 2, studentId: "stu-amal", subjectId: null },
      { code: "unmapped_subject", count: 2, studentId: null, subjectId: "sub-art" },
    ]);
  });

  test("a national ID column with no record field to read is one template issue", () => {
    const output = buildMinistryExport(
      template(),
      [row({ nationalId: null }), row({ nationalId: null, studentId: "stu-badr" })],
      { nationalIdSourceSet: false },
    );
    expect(output.issues).toEqual([
      { code: "national_id_source_missing", count: 2, studentId: null, subjectId: null },
    ]);
  });
});

describe("examples", () => {
  test("are marked as editable examples, not official formats", () => {
    for (const example of MINISTRY_EXPORT_EXAMPLES) {
      expect(example.name.en).toContain("(example)");
      expect(example.name.ar).toContain("(مثال)");
      expect(example.note.en).toContain("not an official");
    }
    expect(ministryExportExample("overall_results")?.template.rowKind).toBe("overall");
    expect(ministryExportExample("nope")).toBeNull();
  });
});
