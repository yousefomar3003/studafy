import type {
  RecordFieldOption,
  RecordFieldSensitivity,
  RecordFieldType,
} from "@studafy/records/browser";

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
  "grade",
  "section",
  "family",
  "parent_name",
  "parent_email",
  "parent_phone",
  "parent_relationship",
  "parent2_name",
  "parent2_email",
  "parent2_phone",
  "parent2_relationship",
] as const;

export type StudentImportField = (typeof STUDENT_IMPORT_FIELDS)[number];

/**
 * Where a mapped value is written: app.students (+ its app.users row), the parent's app.users row,
 * the app.parent_child_links edge between them, or the student's section placement
 * (app.student_sections). `family` is "grouping": it is never stored, only used to give siblings
 * on several lines the same parents.
 */
export type StudentImportTarget = "students" | "parents" | "links" | "placement" | "grouping";

export interface StudentImportFieldDefinition {
  target: StudentImportTarget;
  required: boolean;
  /** Header spellings recognised by `suggestColumnMapping`, compared after `normalizeHeader`. The
   * field's own name is always recognised and is not repeated here. Arabic spellings are listed
   * too, with and without hamza, since schools type both. */
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
      "رقم القيد",
      "الرقم المدرسي",
      "رقم الطالب",
    ],
  },
  // Optional: students sign in with their member ID and a password (000141), not an email.
  email: {
    target: "students",
    required: false,
    aliases: [
      "student email",
      "email address",
      "e-mail",
      "student email address",
      "البريد الإلكتروني",
      "البريد الالكتروني",
      "بريد الطالب",
    ],
  },
  first_name: {
    target: "students",
    required: true,
    aliases: ["given name", "forename", "first", "الاسم الأول", "الاسم الاول"],
  },
  middle_name: {
    target: "students",
    required: false,
    aliases: ["middle", "الاسم الأوسط", "الاسم الاوسط", "اسم الأب", "اسم الاب"],
  },
  last_name: {
    target: "students",
    required: true,
    aliases: ["surname", "family name", "last", "اسم العائلة", "الكنية"],
  },
  preferred_name: {
    target: "students",
    required: false,
    aliases: ["nickname", "known as", "الاسم المفضل"],
  },
  date_of_birth: {
    target: "students",
    required: false,
    aliases: ["dob", "birth date", "birthdate", "birthday", "تاريخ الميلاد"],
  },
  status: {
    target: "students",
    required: false,
    aliases: ["student status", "enrollment status", "enrolment status", "الحالة", "حالة الطالب"],
  },
  grade: {
    target: "placement",
    required: false,
    aliases: ["grade level", "year group", "class level", "الصف", "المرحلة الدراسية"],
  },
  section: {
    target: "placement",
    required: false,
    aliases: ["class section", "homeroom", "الشعبة", "الفصل"],
  },
  family: {
    target: "grouping",
    required: false,
    aliases: [
      "family number",
      "family no",
      "family id",
      "family code",
      "household",
      "رقم العائلة",
      "رقم الأسرة",
      "رقم الاسرة",
    ],
  },
  parent_name: {
    target: "parents",
    required: false,
    aliases: [
      "guardian name",
      "parent full name",
      "guardian full name",
      "parent 1 name",
      "guardian 1 name",
      "اسم ولي الأمر",
      "اسم ولي الامر",
      "اسم ولي الأمر 1",
      "اسم ولي الامر 1",
    ],
  },
  parent_email: {
    target: "parents",
    required: false,
    aliases: [
      "guardian email",
      "parent email address",
      "guardian email address",
      "parent 1 email",
      "guardian 1 email",
      "بريد ولي الأمر",
      "بريد ولي الامر",
      "بريد ولي الأمر 1",
      "بريد ولي الامر 1",
    ],
  },
  // Required for every parent a line names (record.ts parentIssues), not for every line: a
  // sibling's line leaves its family's parents blank.
  parent_phone: {
    target: "parents",
    required: false,
    aliases: [
      "parent phone",
      "parent mobile",
      "parent phone number",
      "parent mobile number",
      "guardian phone",
      "guardian mobile",
      "parent 1 phone",
      "parent 1 mobile",
      "guardian 1 phone",
      "هاتف ولي الأمر",
      "هاتف ولي الامر",
      "جوال ولي الأمر",
      "جوال ولي الامر",
      "رقم هاتف ولي الأمر",
      "رقم هاتف ولي الامر",
      "هاتف ولي الأمر 1",
      "هاتف ولي الامر 1",
    ],
  },
  parent_relationship: {
    target: "links",
    required: false,
    aliases: [
      "relationship",
      "guardian relationship",
      "relation",
      "parent 1 relationship",
      "guardian 1 relationship",
      "صلة القرابة",
      "صلة القرابة 1",
    ],
  },
  parent2_name: {
    target: "parents",
    required: false,
    aliases: [
      "parent 2 name",
      "second parent name",
      "guardian 2 name",
      "اسم ولي الأمر 2",
      "اسم ولي الامر 2",
    ],
  },
  parent2_email: {
    target: "parents",
    required: false,
    aliases: [
      "parent 2 email",
      "second parent email",
      "guardian 2 email",
      "بريد ولي الأمر 2",
      "بريد ولي الامر 2",
    ],
  },
  parent2_phone: {
    target: "parents",
    required: false,
    aliases: [
      "parent 2 phone",
      "parent 2 mobile",
      "second parent phone",
      "guardian 2 phone",
      "هاتف ولي الأمر 2",
      "هاتف ولي الامر 2",
      "جوال ولي الأمر 2",
      "جوال ولي الامر 2",
    ],
  },
  parent2_relationship: {
    target: "links",
    required: false,
    aliases: [
      "parent 2 relationship",
      "second parent relationship",
      "guardian 2 relationship",
      "صلة القرابة 2",
    ],
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

/**
 * A field of the school's published student record template, offered as an import column next to
 * the fixed ones (docs/modules/student-records.md "CSV import"). The mapping keys these by field id
 * under `records`; a document field is listed so the mapping can explain why it is refused.
 */
export interface ImportRecordField {
  id: string;
  field_type: RecordFieldType;
  options: readonly RecordFieldOption[];
  label_en: string;
  label_ar: string;
  sensitivity: RecordFieldSensitivity;
}
