import { z } from "zod";

import { PARENT_RELATIONSHIPS, STUDENT_IMPORT_FIELDS, STUDENT_STATUSES } from "./fields";

import type { ParentRelationship, StudentImportField, StudentStatus } from "./fields";

/**
 * One mapped, validated CSV line — the shape staged in app.student_import_rows.record.
 *
 * `null` means "this file does not provide a value": a create falls back to the column default,
 * and an update leaves the live value alone. An import therefore never blanks out existing data.
 */
export interface StudentImportRecord {
  admission_number: string;
  email: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  status: StudentStatus | null;
  parent_email: string | null;
  parent_name: string | null;
  parent_relationship: ParentRelationship | null;
}

/** A problem with one line (or, at the header line, with the mapping itself). */
export interface StudentImportIssue {
  /** 1-based line in the uploaded file. */
  line: number;
  /** The import field the problem is about, or "row" when it is not about one field. */
  field: string;
  message: string;
}

export type StudentImportValues = Partial<Record<StudentImportField, string | null>>;

const REQUIRED = "Required.";

const requiredText = (max: number) =>
  z.string({ error: REQUIRED }).min(1, REQUIRED).max(max, `At most ${max} characters.`);
const optionalText = (max: number) => z.string().max(max, `At most ${max} characters.`).nullable();
const email = () => z.email({ error: "Not a valid email address." }).max(320);

const recordSchema = z.object({
  admission_number: requiredText(100),
  email: email(),
  first_name: requiredText(100),
  middle_name: optionalText(100),
  last_name: requiredText(100),
  preferred_name: optionalText(100),
  date_of_birth: z.iso.date({ error: "Use the YYYY-MM-DD format." }).nullable(),
  status: z.enum(STUDENT_STATUSES, { error: `One of: ${STUDENT_STATUSES.join(", ")}.` }).nullable(),
  parent_email: email().nullable(),
  parent_name: optionalText(200),
  parent_relationship: z
    .enum(PARENT_RELATIONSHIPS, { error: `One of: ${PARENT_RELATIONSHIPS.join(", ")}.` })
    .nullable(),
});

/**
 * Validate the mapped cells of one line. Blank cells arrive as `null`. Enum-like cells are matched
 * case-insensitively and with spaces or hyphens read as underscores, so "Step-Parent" is accepted.
 */
export function toStudentImportRecord(
  line: number,
  values: StudentImportValues,
): { record: StudentImportRecord; issues: [] } | { record: null; issues: StudentImportIssue[] } {
  const input: Record<StudentImportField, string | null> = Object.fromEntries(
    STUDENT_IMPORT_FIELDS.map((field) => [field, values[field] ?? null]),
  ) as Record<StudentImportField, string | null>;
  input.status = toEnumToken(input.status);
  input.parent_relationship = toEnumToken(input.parent_relationship);

  const parsed = recordSchema.safeParse(input);
  // Checked on the raw input, not inside the schema: zod skips object refinements once any field
  // fails, which would hide these until the admin had fixed everything else and uploaded again.
  const issues = [
    ...(parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          line,
          field: issue.path.join(".") || "row",
          message: issue.message,
        }))),
    ...parentIssues(line, input),
  ];

  if (parsed.success && issues.length === 0) return { record: parsed.data, issues: [] };
  return { record: null, issues };
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeAdmissionNumber(value: string): string {
  return value.trim().toLowerCase();
}

/** A parent is all-or-nothing: an email to find or create the account, and a relationship for the
 * link. Either without the other would be silently dropped, so it is an error instead. */
function parentIssues(
  line: number,
  input: Record<StudentImportField, string | null>,
): StudentImportIssue[] {
  if (input.parent_email === null) {
    return input.parent_relationship !== null || input.parent_name !== null
      ? [{ line, field: "parent_email", message: "Required with parent details." }]
      : [];
  }
  const issues: StudentImportIssue[] = [];
  if (input.parent_relationship === null) {
    issues.push({
      line,
      field: "parent_relationship",
      message: "Required when parent_email is set.",
    });
  }
  if (input.email !== null && normalizeEmail(input.parent_email) === normalizeEmail(input.email)) {
    issues.push({ line, field: "parent_email", message: "Must differ from the student's email." });
  }
  return issues;
}

function toEnumToken(value: string | null): string | null {
  return value === null
    ? null
    : value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
}
