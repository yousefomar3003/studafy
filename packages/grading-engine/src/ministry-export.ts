/**
 * Ministry results export: a school's finalized results laid out the way a ministry (or a platform
 * like Noor or eSIS) asks for them.
 *
 * Ministry formats differ from country to country and change from year to year, so nothing here is
 * a hard-coded format. A school keeps export templates (db/migrations/000264): a target label, a
 * file type, an encoding, whether a row is one student's result in one subject or their overall
 * result, and an ordered list of columns. Each column takes one known field (the national ID, the
 * admission number, a name, the grade, the mark...) or a fixed text, and may translate the value
 * through a value map (our "pass" -> the ministry's "1"). The ministry's own subject codes are a
 * per-subject mapping table on the template.
 *
 * The examples at the bottom are editable starting points, never official formats.
 *
 * Everything here is pure: the API loads finalized results, resolves the national IDs it may
 * show, and calls {@link buildMinistryExport} for both the preview and the file, so the preview
 * is exactly the first rows of the file. The web form checks a template with
 * {@link validateMinistryExportTemplate}, the same rules the API applies.
 */

import { roundTo } from "./rounding";

import type { LocalizedText } from "./templates";
import type { ValidationIssue } from "./types";

export const MINISTRY_EXPORT_FILE_FORMATS = ["csv", "xlsx"] as const;
export type MinistryExportFileFormat = (typeof MINISTRY_EXPORT_FILE_FORMATS)[number];

/** `utf8_bom` starts the file with U+FEFF, so Excel reads Arabic in a CSV as UTF-8. */
export const MINISTRY_EXPORT_ENCODINGS = ["utf8", "utf8_bom"] as const;
export type MinistryExportEncoding = (typeof MINISTRY_EXPORT_ENCODINGS)[number];

/** `subject`: one row per student per subject. `overall`: one row per student. */
export const MINISTRY_EXPORT_ROW_KINDS = ["subject", "overall"] as const;
export type MinistryExportRowKind = (typeof MINISTRY_EXPORT_ROW_KINDS)[number];

/**
 * The fields a column can take. Adding one is additive: the API, the database CHECK
 * (ck_ministry_export_columns_field) and the web labels list the same set.
 *
 * EXTENSION POINT (Arabic names, WS-K / 000263): once students and subjects carry Arabic names,
 * add `first_name_ar`, `middle_name_ar`, `last_name_ar`, `full_name_ar` and `subject_name_ar`
 * here, to the CHECK in a new migration, to the source row below, and to the API's row query.
 */
export const MINISTRY_EXPORT_FIELDS = [
  "national_id",
  "admission_number",
  "first_name",
  "middle_name",
  "last_name",
  "full_name",
  "date_of_birth",
  "grade_level",
  "section",
  "academic_year",
  "term",
  "subject_code",
  "subject_name",
  "subject_ministry_code",
  "mark",
  "max_mark",
  "percentage",
  "grade_label",
  "gpa",
  "status",
  "constant",
] as const;
export type MinistryExportField = (typeof MINISTRY_EXPORT_FIELDS)[number];

/** Fields that only exist on a per-subject row. */
export const MINISTRY_EXPORT_SUBJECT_FIELDS: readonly MinistryExportField[] = [
  "subject_code",
  "subject_name",
  "subject_ministry_code",
];

/** Fields written as numbers (in an XLSX) unless the column maps them to other values. */
export const MINISTRY_EXPORT_NUMERIC_FIELDS: readonly MinistryExportField[] = [
  "mark",
  "max_mark",
  "percentage",
  "gpa",
];

/** What the `term` field holds for a whole-year (annual) result; a value map can rename it. */
export const MINISTRY_EXPORT_ANNUAL_TERM = "Annual";

/**
 * The `status` field's values. A per-subject row: pass, fail, incomplete (marks missing) or
 * exempt. An overall row: the academic status, promoted, supplementary, retained or incomplete.
 * Value maps turn them into the ministry's words or codes.
 */
export const MINISTRY_EXPORT_SUBJECT_STATUSES = ["pass", "fail", "incomplete", "exempt"] as const;
export const MINISTRY_EXPORT_OVERALL_STATUSES = [
  "promoted",
  "supplementary",
  "retained",
  "incomplete",
] as const;

/** Limits shared by the API's request validation, the database CHECKs and the web form. */
export const MINISTRY_EXPORT_LIMITS = {
  nameMaxLength: 120,
  targetMaxLength: 120,
  headerMaxLength: 120,
  valueMaxLength: 200,
  subjectCodeMaxLength: 60,
  maxColumns: 60,
  maxValueMapEntries: 200,
  maxSubjectCodes: 500,
  maxDecimalPlaces: 3,
  /** Rows the preview shows. */
  previewRows: 20,
} as const;

export interface MinistryExportValueMapEntry {
  from: string;
  to: string;
}

export interface MinistryExportColumnDefinition {
  header: string;
  field: MinistryExportField;
  /** The text every row gets; `constant` columns only. */
  constantValue: string | null;
  valueMap: readonly MinistryExportValueMapEntry[];
}

export interface MinistryExportTemplateDefinition {
  name: string;
  target: string;
  fileFormat: MinistryExportFileFormat;
  encoding: MinistryExportEncoding;
  rowKind: MinistryExportRowKind;
  /** Decimals for marks, percentages and GPAs, rounded half up. */
  decimalPlaces: number;
  columns: readonly MinistryExportColumnDefinition[];
}

const issue = (code: string, message: string, ref?: string): ValidationIssue => ({
  code,
  severity: "error",
  message,
  ...(ref === undefined ? {} : { ref }),
});

const blank = (text: string) => text.trim() === "";

/** Everything wrong with a template, or nothing. Indexes in messages are 1-based. */
export function validateMinistryExportTemplate(
  template: MinistryExportTemplateDefinition,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const limits = MINISTRY_EXPORT_LIMITS;
  if (blank(template.name)) issues.push(issue("NAME_REQUIRED", "Enter a name."));
  if (template.name.trim().length > limits.nameMaxLength) {
    issues.push(issue("NAME_TOO_LONG", `The name is longer than ${limits.nameMaxLength}.`));
  }
  if (template.target.trim().length > limits.targetMaxLength) {
    issues.push(issue("TARGET_TOO_LONG", `The target is longer than ${limits.targetMaxLength}.`));
  }
  if (
    !Number.isInteger(template.decimalPlaces) ||
    template.decimalPlaces < 0 ||
    template.decimalPlaces > limits.maxDecimalPlaces
  ) {
    issues.push(
      issue(
        "DECIMALS",
        `Decimal places must be a whole number from 0 to ${limits.maxDecimalPlaces}.`,
      ),
    );
  }
  if (template.columns.length === 0) {
    issues.push(issue("NO_COLUMNS", "Add at least one column."));
  }
  if (template.columns.length > limits.maxColumns) {
    issues.push(issue("TOO_MANY_COLUMNS", `A template has at most ${limits.maxColumns} columns.`));
  }

  const headers = new Set<string>();
  template.columns.forEach((column, index) => {
    const n = index + 1;
    const ref = String(index);
    if (blank(column.header)) {
      issues.push(issue("HEADER_REQUIRED", `Column ${n}: enter a heading.`, ref));
    } else if (column.header.trim().length > limits.headerMaxLength) {
      issues.push(issue("HEADER_TOO_LONG", `Column ${n}: the heading is too long.`, ref));
    } else {
      const key = column.header.trim().toLowerCase();
      if (headers.has(key)) {
        issues.push(
          issue("HEADER_DUPLICATE", `Column ${n}: another column has this heading.`, ref),
        );
      }
      headers.add(key);
    }
    if (!(MINISTRY_EXPORT_FIELDS as readonly string[]).includes(column.field)) {
      issues.push(issue("FIELD_UNKNOWN", `Column ${n}: unknown field.`, ref));
    }
    if (template.rowKind === "overall" && MINISTRY_EXPORT_SUBJECT_FIELDS.includes(column.field)) {
      issues.push(
        issue(
          "FIELD_NEEDS_SUBJECT_ROWS",
          `Column ${n}: subject fields need one row per subject.`,
          ref,
        ),
      );
    }
    if (column.field === "constant") {
      if (column.constantValue === null || blank(column.constantValue)) {
        issues.push(issue("CONSTANT_REQUIRED", `Column ${n}: enter the fixed text.`, ref));
      } else if (column.constantValue.trim().length > limits.valueMaxLength) {
        issues.push(issue("CONSTANT_TOO_LONG", `Column ${n}: the fixed text is too long.`, ref));
      }
      if (column.valueMap.length > 0) {
        issues.push(issue("CONSTANT_MAPPED", `Column ${n}: fixed text takes no value map.`, ref));
      }
    } else if (column.constantValue !== null) {
      issues.push(
        issue("CONSTANT_UNEXPECTED", `Column ${n}: only a fixed-text column has one.`, ref),
      );
    }
    if (column.valueMap.length > limits.maxValueMapEntries) {
      issues.push(
        issue(
          "VALUE_MAP_TOO_LONG",
          `Column ${n}: at most ${limits.maxValueMapEntries} values.`,
          ref,
        ),
      );
    }
    const froms = new Set<string>();
    column.valueMap.forEach((entry, entryIndex) => {
      const from = entry.from.trim();
      if (from === "") {
        issues.push(
          issue("VALUE_MAP_FROM", `Column ${n}, value ${entryIndex + 1}: enter our value.`, ref),
        );
      } else if (froms.has(from)) {
        issues.push(
          issue("VALUE_MAP_DUPLICATE", `Column ${n}: "${from}" is mapped more than once.`, ref),
        );
      }
      froms.add(from);
      if (from.length > limits.valueMaxLength || entry.to.trim().length > limits.valueMaxLength) {
        issues.push(
          issue("VALUE_MAP_TOO_LONG_VALUE", `Column ${n}: a mapped value is too long.`, ref),
        );
      }
    });
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Building the rows
// ---------------------------------------------------------------------------

/**
 * One finalized result, as the API read it. Names and codes are the school's current ones; the
 * figures are the finalized snapshot's.
 */
export interface MinistryExportSourceRow {
  studentId: string;
  /** Resolved by the API: the full value, its mask (preview of a sensitive field), or null. */
  nationalId: string | null;
  admissionNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  /** ISO date (YYYY-MM-DD). */
  dateOfBirth: string | null;
  gradeLevel: string;
  section: string;
  sectionId: string;
  academicYear: string;
  /** The term's name, or null for the whole year. */
  term: string | null;
  /** Per-subject rows only. */
  subject: { id: string; code: string; name: string } | null;
  /** The template's code for the subject, null when it has none. */
  subjectMinistryCode: string | null;
  /** See MINISTRY_EXPORT_SUBJECT_STATUSES / MINISTRY_EXPORT_OVERALL_STATUSES. */
  status: string;
  mark: number | null;
  maxMark: number | null;
  percentage: number | null;
  gradeLabel: string | null;
  gpa: number | null;
}

export type MinistryExportIssueCode =
  "national_id_source_missing" | "missing_national_id" | "unmapped_subject";

/**
 * A problem with the file the school should fix before sending it. One entry per student without
 * a national ID and per subject without a ministry code (`count` rows each), and one for a template
 * whose national ID column has no record field to read from.
 */
export interface MinistryExportIssue {
  code: MinistryExportIssueCode;
  count: number;
  studentId: string | null;
  subjectId: string | null;
}

export interface MinistryExportOutput {
  header: string[];
  rows: string[][];
  /** Per column: write it as a number in a spreadsheet (a numeric field with no value map). */
  numericColumns: boolean[];
  issues: MinistryExportIssue[];
}

export interface MinistryExportContext {
  /** Whether the template names the record field the national ID is read from. */
  nationalIdSourceSet: boolean;
}

/** A number with exactly `decimals` decimals, rounded half up; "" for none. */
export function formatExportNumber(value: number | null, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return "";
  return roundTo(value, { decimals, mode: "half_up" }).toFixed(decimals);
}

/** The value a map gives `text`, or `text` itself when the map does not list it. */
export function applyValueMap(
  text: string,
  valueMap: readonly MinistryExportValueMapEntry[],
): string {
  const key = text.trim();
  const entry = valueMap.find((candidate) => candidate.from.trim() === key);
  return entry ? entry.to.trim() : text;
}

function fullName(row: MinistryExportSourceRow): string {
  return [row.firstName, row.middleName, row.lastName]
    .filter((part): part is string => part !== null && part.trim() !== "")
    .join(" ");
}

function rawValue(
  row: MinistryExportSourceRow,
  column: MinistryExportColumnDefinition,
  decimals: number,
): string {
  switch (column.field) {
    case "national_id":
      return row.nationalId ?? "";
    case "admission_number":
      return row.admissionNumber;
    case "first_name":
      return row.firstName;
    case "middle_name":
      return row.middleName ?? "";
    case "last_name":
      return row.lastName;
    case "full_name":
      return fullName(row);
    case "date_of_birth":
      return row.dateOfBirth ?? "";
    case "grade_level":
      return row.gradeLevel;
    case "section":
      return row.section;
    case "academic_year":
      return row.academicYear;
    case "term":
      return row.term ?? MINISTRY_EXPORT_ANNUAL_TERM;
    case "subject_code":
      return row.subject?.code ?? "";
    case "subject_name":
      return row.subject?.name ?? "";
    case "subject_ministry_code":
      return row.subjectMinistryCode ?? "";
    case "mark":
      return formatExportNumber(row.mark, decimals);
    case "max_mark":
      return formatExportNumber(row.maxMark, decimals);
    case "percentage":
      return formatExportNumber(row.percentage, decimals);
    case "grade_label":
      return row.gradeLabel ?? "";
    case "gpa":
      return formatExportNumber(row.gpa, decimals);
    case "status":
      return row.status;
    case "constant":
      return column.constantValue?.trim() ?? "";
  }
}

/**
 * The file's heading row and data rows (all text), in the source rows' order, and what is missing
 * from them. Called with every row for the file and for the preview alike.
 */
export function buildMinistryExport(
  template: Pick<MinistryExportTemplateDefinition, "columns" | "decimalPlaces">,
  source: readonly MinistryExportSourceRow[],
  context: MinistryExportContext,
): MinistryExportOutput {
  const columns = template.columns;
  const header = columns.map((column) => column.header.trim());
  const numericColumns = columns.map(
    (column) =>
      MINISTRY_EXPORT_NUMERIC_FIELDS.includes(column.field) && column.valueMap.length === 0,
  );
  const rows = source.map((row) =>
    columns.map((column) => {
      const value = rawValue(row, column, template.decimalPlaces);
      return column.field === "constant" ? value : applyValueMap(value, column.valueMap);
    }),
  );

  const issues: MinistryExportIssue[] = [];
  const usesNationalId = columns.some((column) => column.field === "national_id");
  if (usesNationalId && !context.nationalIdSourceSet) {
    issues.push({
      code: "national_id_source_missing",
      count: source.length,
      studentId: null,
      subjectId: null,
    });
  } else if (usesNationalId) {
    const missing = new Map<string, number>();
    for (const row of source) {
      if (row.nationalId === null || row.nationalId.trim() === "") {
        missing.set(row.studentId, (missing.get(row.studentId) ?? 0) + 1);
      }
    }
    for (const [studentId, count] of missing) {
      issues.push({ code: "missing_national_id", count, studentId, subjectId: null });
    }
  }
  if (columns.some((column) => column.field === "subject_ministry_code")) {
    const unmapped = new Map<string, number>();
    for (const row of source) {
      if (row.subject && row.subjectMinistryCode === null) {
        unmapped.set(row.subject.id, (unmapped.get(row.subject.id) ?? 0) + 1);
      }
    }
    for (const [subjectId, count] of unmapped) {
      issues.push({ code: "unmapped_subject", count, studentId: null, subjectId });
    }
  }
  return { header, rows, numericColumns, issues };
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

export const MINISTRY_EXPORT_EXAMPLE_KEYS = [
  "results_by_subject",
  "overall_results",
  "arabic_headings",
] as const;
export type MinistryExportExampleKey = (typeof MINISTRY_EXPORT_EXAMPLE_KEYS)[number];

export interface MinistryExportExample {
  key: MinistryExportExampleKey;
  name: LocalizedText;
  /** What to check before using it: every example is editable and none is an official format. */
  note: LocalizedText;
  template: MinistryExportTemplateDefinition;
}

const col = (
  header: string,
  field: MinistryExportField,
  valueMap: MinistryExportValueMapEntry[] = [],
): MinistryExportColumnDefinition => ({ header, field, constantValue: null, valueMap });

const EXAMPLE_NOTE: LocalizedText = {
  en:
    "An editable example, not an official ministry format. Check the columns, codes, file type " +
    "and encoding against your ministry's current instructions before sending a file.",
  ar:
    "مثال قابل للتعديل، وليس صيغة رسمية لأي وزارة. راجع الأعمدة والرموز ونوع الملف والترميز " +
    "وفق تعليمات الوزارة الحالية قبل إرسال أي ملف.",
};

/** Editable starting points. None of them is a ministry's official format. */
export const MINISTRY_EXPORT_EXAMPLES: readonly MinistryExportExample[] = [
  {
    key: "results_by_subject",
    name: { en: "Results by subject (example)", ar: "النتائج حسب المادة (مثال)" },
    note: EXAMPLE_NOTE,
    template: {
      name: "Results by subject",
      target: "Ministry of Education",
      fileFormat: "csv",
      encoding: "utf8_bom",
      rowKind: "subject",
      decimalPlaces: 2,
      columns: [
        col("National ID", "national_id"),
        col("Student number", "admission_number"),
        col("Student name", "full_name"),
        col("Grade", "grade_level"),
        col("Section", "section"),
        col("Subject code", "subject_ministry_code"),
        col("Subject", "subject_name"),
        col("Mark", "mark"),
        col("Out of", "max_mark"),
        col("Percentage", "percentage"),
        col("Grade label", "grade_label"),
        col("Result", "status", [
          { from: "pass", to: "Pass" },
          { from: "fail", to: "Fail" },
          { from: "incomplete", to: "Incomplete" },
          { from: "exempt", to: "Exempt" },
        ]),
      ],
    },
  },
  {
    key: "overall_results",
    name: { en: "Overall results (example)", ar: "النتيجة النهائية (مثال)" },
    note: EXAMPLE_NOTE,
    template: {
      name: "Overall results",
      target: "Ministry of Education",
      fileFormat: "xlsx",
      encoding: "utf8",
      rowKind: "overall",
      decimalPlaces: 2,
      columns: [
        col("National ID", "national_id"),
        col("Student name", "full_name"),
        col("Grade", "grade_level"),
        col("Section", "section"),
        col("Academic year", "academic_year"),
        col("Term", "term"),
        col("Average", "percentage"),
        col("Grade label", "grade_label"),
        col("Result", "status", [
          { from: "promoted", to: "Promoted" },
          { from: "supplementary", to: "Supplementary" },
          { from: "retained", to: "Retained" },
          { from: "incomplete", to: "Incomplete" },
        ]),
      ],
    },
  },
  {
    key: "arabic_headings",
    name: { en: "Arabic headings, by subject (example)", ar: "عناوين عربية، حسب المادة (مثال)" },
    note: EXAMPLE_NOTE,
    template: {
      name: "Arabic headings by subject",
      target: "Ministry of Education",
      fileFormat: "csv",
      encoding: "utf8_bom",
      rowKind: "subject",
      decimalPlaces: 0,
      columns: [
        col("الرقم الوطني", "national_id"),
        col("اسم الطالب", "full_name"),
        col("الصف", "grade_level"),
        col("الشعبة", "section"),
        col("رمز المبحث", "subject_ministry_code"),
        col("العلامة", "mark"),
        col("النتيجة", "status", [
          { from: "pass", to: "ناجح" },
          { from: "fail", to: "راسب" },
          { from: "incomplete", to: "غير مكتمل" },
          { from: "exempt", to: "معفى" },
        ]),
      ],
    },
  },
];

export function ministryExportExample(key: string): MinistryExportExample | null {
  return MINISTRY_EXPORT_EXAMPLES.find((example) => example.key === key) ?? null;
}
