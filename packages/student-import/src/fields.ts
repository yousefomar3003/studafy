/**
 * The closed set of fields a student CSV can be mapped onto, and the table each one lands in.
 *
 * A column mapping is `field -> source header`. Every key of a saved or submitted mapping must be
 * one of these fields; the value is whatever the school's own export calls that column.
 */

export const STUDENT_IMPORT_FIELDS = [
  "admission_number",
  "email",
  "first_name",
  "middle_name",
  "last_name",
  "preferred_name",
  "date_of_birth",
  "status",
  "parent_email",
  "parent_name",
  "parent_relationship",
] as const;

export type StudentImportField = (typeof STUDENT_IMPORT_FIELDS)[number];

/** Where a mapped value is written: app.students (+ its app.users row), the parent's app.users row,
 * or the app.parent_child_links edge between them. */
export type StudentImportTarget = "students" | "parents" | "links";

export interface StudentImportFieldDefinition {
  target: StudentImportTarget;
  required: boolean;
  /** Header spellings recognised by `suggestColumnMapping`, compared after `normalizeHeader`. The
   * field's own name is always recognised and is not repeated here. */
  aliases: readonly string[];
}

export const STUDENT_IMPORT_FIELD_DEFINITIONS: Readonly<
  Record<StudentImportField, StudentImportFieldDefinition>
> = {
  admission_number: {
    target: "students",
    required: true,
    aliases: [
      "admission no",
      "admission #",
      "student id",
      "student number",
      "student no",
      "roll number",
      "enrollment number",
      "enrolment number",
    ],
  },
  email: {
    target: "students",
    required: true,
    aliases: ["student email", "email address", "e-mail", "student email address"],
  },
  first_name: {
    target: "students",
    required: true,
    aliases: ["given name", "forename", "first"],
  },
  middle_name: { target: "students", required: false, aliases: ["middle"] },
  last_name: {
    target: "students",
    required: true,
    aliases: ["surname", "family name", "last"],
  },
  preferred_name: { target: "students", required: false, aliases: ["nickname", "known as"] },
  date_of_birth: {
    target: "students",
    required: false,
    aliases: ["dob", "birth date", "birthdate", "birthday"],
  },
  status: {
    target: "students",
    required: false,
    aliases: ["student status", "enrollment status", "enrolment status"],
  },
  parent_email: {
    target: "parents",
    required: false,
    aliases: ["guardian email", "parent email address", "guardian email address"],
  },
  parent_name: {
    target: "parents",
    required: false,
    aliases: ["guardian name", "parent full name", "guardian full name"],
  },
  parent_relationship: {
    target: "links",
    required: false,
    aliases: ["relationship", "guardian relationship", "relation"],
  },
};

export const REQUIRED_STUDENT_IMPORT_FIELDS: readonly StudentImportField[] =
  STUDENT_IMPORT_FIELDS.filter((field) => STUDENT_IMPORT_FIELD_DEFINITIONS[field].required);

/** Mirrors the app.student_status enum. */
export const STUDENT_STATUSES = [
  "applicant",
  "enrolled",
  "suspended",
  "graduated",
  "withdrawn",
  "archived",
] as const;

export type StudentStatus = (typeof STUDENT_STATUSES)[number];

/** Mirrors the app.parent_relationship enum. */
export const PARENT_RELATIONSHIPS = [
  "mother",
  "father",
  "guardian",
  "step_parent",
  "grandparent",
  "sibling",
  "other",
] as const;

export type ParentRelationship = (typeof PARENT_RELATIONSHIPS)[number];
