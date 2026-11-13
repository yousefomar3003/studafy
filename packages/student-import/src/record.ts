import { normalizePhoneNumber, PHONE_MAX } from "@studafy/records/browser";
import { z } from "zod";

import { PARENT_RELATIONSHIPS, STUDENT_IMPORT_FIELDS, STUDENT_STATUSES } from "./fields";

import type { ParentRelationship, StudentImportField, StudentStatus } from "./fields";
import type { RecordValue } from "@studafy/records/browser";

/**
 * One mapped, validated CSV line — the shape staged in app.student_import_rows.record.
 *
 * `null` means "this file does not provide a value": a create falls back to the column default,
 * and an update leaves the live value alone. An import therefore never blanks out existing data.
 */
export interface StudentImportRecord {
  admission_number: string;
  /** Null: the student signs in with their member ID and a password, not an email (000141). */
  email: string | null;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  status: StudentStatus | null;
  /** The grade and section to place the student in, by name, for the current academic year. */
  grade: string | null;
  section: string | null;
  /** The school's own family number: lines sharing one share their parents. Never stored. */
  family: string | null;
  /**
   * Parent 1. A parent needs a name or an email (no email: they sign in with their member ID), a
   * phone number and a relationship. The phone is contact data only, never used to match anyone.
   */
  parent_email: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  parent_relationship: ParentRelationship | null;
  /** Parent 2, the same way. */
  parent2_email: string | null;
  parent2_name: string | null;
  parent2_phone: string | null;
  parent2_relationship: ParentRelationship | null;
  /**
   * Answers for the school's student record template, by field id: only the cells the file
   * actually fills (an empty cell leaves a live answer alone, like every other column). Absent on
   * rows staged before template columns existed.
   */
  records?: Record<string, RecordValue>;
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
const phone = () =>
  z
    .string()
    .max(PHONE_MAX, `At most ${PHONE_MAX} characters.`)
    .transform((value, context) => {
      const normalized = normalizePhoneNumber(value);
      if (normalized === null) {
        context.addIssue({ code: "custom", message: "Not a valid phone number." });
        return z.NEVER;
      }
      return normalized;
    })
    .nullable();
const relationship = () =>
  z.enum(PARENT_RELATIONSHIPS, { error: `One of: ${PARENT_RELATIONSHIPS.join(", ")}.` }).nullable();

/** Arabic (and common English) words a school types for an enum value, read as that value. */
const RELATIONSHIP_SYNONYMS: Readonly<Record<string, ParentRelationship>> = {
  mom: "mother",
  mum: "mother",
  dad: "father",
  stepparent: "step_parent",
  أم: "mother",
  الأم: "mother",
  ام: "mother",
  الام: "mother",
  والدة: "mother",
  الوالدة: "mother",
  أب: "father",
  الأب: "father",
  اب: "father",
  الاب: "father",
  والد: "father",
  الوالد: "father",
  وصي: "guardian",
  الوصي: "guardian",
  ولي_أمر: "guardian",
  ولي_الأمر: "guardian",
  ولي_امر: "guardian",
  ولي_الامر: "guardian",
  زوج_الأم: "step_parent",
  زوج_الام: "step_parent",
  زوجة_الأب: "step_parent",
  زوجة_الاب: "step_parent",
  جد: "grandparent",
  الجد: "grandparent",
  جدة: "grandparent",
  الجدة: "grandparent",
  أخ: "sibling",
  الأخ: "sibling",
  اخ: "sibling",
  الاخ: "sibling",
  أخت: "sibling",
  الأخت: "sibling",
  اخت: "sibling",
  الاخت: "sibling",
  آخر: "other",
  اخر: "other",
  أخرى: "other",
  اخرى: "other",
};

const STATUS_SYNONYMS: Readonly<Record<string, StudentStatus>> = {
  active: "enrolled",
  مقيد: "enrolled",
  مسجل: "enrolled",
  منتظم: "enrolled",
  متقدم: "applicant",
  موقوف: "suspended",
  متخرج: "graduated",
  خريج: "graduated",
  منسحب: "withdrawn",
  مؤرشف: "archived",
};
const recordSchema = z.object({
  admission_number: requiredText(100),
  email: email().nullable(),
  first_name: requiredText(100),
  middle_name: optionalText(100),
  last_name: requiredText(100),
  preferred_name: optionalText(100),
  date_of_birth: z.iso.date({ error: "Use the YYYY-MM-DD format." }).nullable(),
  status: z.enum(STUDENT_STATUSES, { error: `One of: ${STUDENT_STATUSES.join(", ")}.` }).nullable(),
  grade: optionalText(100),
  section: optionalText(100),
  family: optionalText(100),
  parent_email: email().nullable(),
  parent_name: optionalText(200),
  parent_phone: phone(),
  parent_relationship: relationship(),
  parent2_email: email().nullable(),
  parent2_name: optionalText(200),
  parent2_phone: phone(),
  parent2_relationship: relationship(),
});

/**
 * A staged record as the current code expects it. Rows staged by an earlier release lack the
 * fields added since (ST-299's parent_name, then placement, family, parent 2 and the parents'
 * phones); a missing one
 * means the file did not provide it.
 */
export function withRecordDefaults(record: StudentImportRecord): StudentImportRecord {
  return {
    ...record,
    email: record.email ?? null,
    parent_name: record.parent_name ?? null,
    parent_phone: record.parent_phone ?? null,
    grade: record.grade ?? null,
    section: record.section ?? null,
    family: record.family ?? null,
    parent2_email: record.parent2_email ?? null,
    parent2_name: record.parent2_name ?? null,
    parent2_phone: record.parent2_phone ?? null,
    parent2_relationship: record.parent2_relationship ?? null,
  };
}

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
  input.status = toEnumToken(input.status, STATUS_SYNONYMS);
  input.parent_relationship = toEnumToken(input.parent_relationship, RELATIONSHIP_SYNONYMS);
  input.parent2_relationship = toEnumToken(input.parent2_relationship, RELATIONSHIP_SYNONYMS);

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
    ...parentIssues(line, input, PARENT_SLOTS[0]),
    ...parentIssues(line, input, PARENT_SLOTS[1]),
    ...placementIssues(line, input),
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

/** The columns of each parent a line can name. */
export const PARENT_SLOTS = [
  {
    email: "parent_email",
    name: "parent_name",
    phone: "parent_phone",
    relationship: "parent_relationship",
  },
  {
    email: "parent2_email",
    name: "parent2_name",
    phone: "parent2_phone",
    relationship: "parent2_relationship",
  },
] as const;

export type ParentSlot = (typeof PARENT_SLOTS)[number];

/**
 * A parent is all-or-nothing: a name or an email to create the account by (with no email they sign
 * in with their member ID), a phone number the school can reach them on, and a relationship for the
 * link. A half-filled parent would be silently dropped, so it is an error instead.
 */
function parentIssues(
  line: number,
  input: Record<StudentImportField, string | null>,
  slot: ParentSlot,
): StudentImportIssue[] {
  const parentEmail = input[slot.email];
  const named = parentEmail !== null || input[slot.name] !== null;
  if (!named) {
    return input[slot.relationship] !== null || input[slot.phone] !== null
      ? [{ line, field: slot.name, message: "Give the parent's name or email." }]
      : [];
  }
  const issues: StudentImportIssue[] = [];
  if (input[slot.relationship] === null) {
    issues.push({
      line,
      field: slot.relationship,
      message: "Required when the parent is given.",
    });
  }
  if (input[slot.phone] === null) {
    issues.push({ line, field: slot.phone, message: "Required when the parent is given." });
  }
  if (parentEmail !== null && input.email !== null) {
    if (normalizeEmail(parentEmail) === normalizeEmail(input.email)) {
      issues.push({ line, field: slot.email, message: "Must differ from the student's email." });
    }
  }
  if (slot === PARENT_SLOTS[1] && parentEmail !== null && input.parent_email !== null) {
    if (normalizeEmail(parentEmail) === normalizeEmail(input.parent_email)) {
      issues.push({ line, field: slot.email, message: "Must differ from parent 1's email." });
    }
  }
  return issues;
}

/** A section is a section of a grade, so it is never given alone. */
function placementIssues(
  line: number,
  input: Record<StudentImportField, string | null>,
): StudentImportIssue[] {
  return input.section !== null && input.grade === null
    ? [{ line, field: "grade", message: "Required when section is set." }]
    : [];
}

function toEnumToken(
  value: string | null,
  synonyms: Readonly<Record<string, string>>,
): string | null {
  if (value === null) return null;
  const token = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return synonyms[token] ?? token;
}
