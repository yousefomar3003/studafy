/**
 * The vocabulary of school-defined student and parent records (docs/modules/student-records.md).
 * Mirrors the enums created by db/migrations/000170_create_student_and_parent_records.sql.
 */

export const RECORD_SUBJECT_KINDS = ["student", "parent"] as const;
export type RecordSubjectKind = (typeof RECORD_SUBJECT_KINDS)[number];

export const RECORD_FIELD_TYPES = [
  "short_text",
  "long_text",
  "number",
  "date",
  "single_choice",
  "multi_choice",
  "yes_no",
  "phone",
  "email",
  "document",
] as const;
export type RecordFieldType = (typeof RECORD_FIELD_TYPES)[number];

export const RECORD_FIELD_VISIBILITIES = ["staff_only", "finance", "teachers", "parent"] as const;
export type RecordFieldVisibility = (typeof RECORD_FIELD_VISIBILITIES)[number];

export const RECORD_FIELD_SENSITIVITIES = ["standard", "sensitive"] as const;
export type RecordFieldSensitivity = (typeof RECORD_FIELD_SENSITIVITIES)[number];

export const RECORD_DOCUMENT_STATUSES = ["missing", "uploaded", "verified"] as const;
export type RecordDocumentStatus = (typeof RECORD_DOCUMENT_STATUSES)[number];

export interface RecordFieldOption {
  value: string;
  label_en: string;
  label_ar: string;
}

/**
 * Who is reading. "staff" is school leadership (ORG_ADMIN, PRINCIPAL), who read every field; the
 * other three read only fields whose visibility reaches them, and never a sensitive one.
 */
export type RecordAudience = "staff" | "finance" | "teachers" | "parent";

/**
 * Visibility is a widening ladder: staff_only < finance < teachers < parent. A field marked
 * "teachers" is therefore also visible to finance, and a "parent" field to teachers and finance.
 */
const LADDER: Record<RecordFieldVisibility, number> = {
  staff_only: 0,
  finance: 1,
  teachers: 2,
  parent: 3,
};

const AUDIENCE_FLOOR: Record<RecordAudience, number> = {
  staff: 0,
  finance: 1,
  teachers: 2,
  parent: 3,
};

/** Whether a field with this visibility and sensitivity may be shown to the audience at all. */
export function isFieldVisibleTo(
  field: { visibility: RecordFieldVisibility; sensitivity: RecordFieldSensitivity },
  audience: RecordAudience,
): boolean {
  if (audience === "staff") return true;
  if (field.sensitivity === "sensitive") return false;
  return LADDER[field.visibility] >= AUDIENCE_FLOOR[audience];
}

/** The visibilities an audience reads, for SQL filters. */
export function visibilitiesFor(audience: RecordAudience): RecordFieldVisibility[] {
  return RECORD_FIELD_VISIBILITIES.filter((v) => LADDER[v] >= AUDIENCE_FLOOR[audience]);
}

/**
 * Months after a subject leaves before the retention job deletes a sensitive answer, when the
 * school has not set its own period on the field. Twelve months covers the year in which a school
 * is still asked for a leaver's transfer paperwork, re-enrolments and fee disputes; past that,
 * identity and medical data about a former pupil serve no purpose the school's ordinary records do
 * not (GDPR art. 5(1)(e), storage limitation). A school can set 1-120 months per field.
 */
export const DEFAULT_SENSITIVE_RETENTION_MONTHS = 12;
export const MIN_RETENTION_MONTHS = 1;
export const MAX_RETENTION_MONTHS = 120;

const SENSITIVE_LABEL_HINTS: readonly RegExp[] = [
  /\b(national|civil|personal|government|state)\s*(id|identity|identification|number|no\.?)\b/i,
  /\bid\s*(number|no\.?|card)\b/i,
  /\b(passport|iqama|residen(ce|cy)\s*(permit|number)|visa|ssn|social\s*security|tax\s*(id|number))\b/i,
  /\b(medical|medication|medicine|diagnos\w*|health|disabilit\w*|condition|illness|mental|therapy|prescription|blood\s*type)\b/i,
  /(هوية|الهوية|رقم\s*مدني|الرقم\s*المدني|البطاقة\s*المدنية|جواز|الجواز|إقامة|الإقامة|تأشيرة|طبي|طبية|صحي|صحية|دواء|أدوية|تشخيص|إعاقة|مرض|فصيلة\s*الدم)/,
];

/**
 * A hint, never a rule: true when a field label reads like an ID number, passport or medical
 * information, so the template editor can suggest marking it sensitive. The school decides.
 */
export function labelSuggestsSensitive(label: string): boolean {
  return SENSITIVE_LABEL_HINTS.some((pattern) => pattern.test(label));
}
