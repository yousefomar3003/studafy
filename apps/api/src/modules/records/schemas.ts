import { z } from "@hono/zod-openapi";
import {
  MAX_RETENTION_MONTHS,
  MIN_RETENTION_MONTHS,
  RECORD_DOCUMENT_STATUSES,
  RECORD_VALUE_ERRORS,
  RECORD_FIELD_SENSITIVITIES,
  RECORD_FIELD_TYPES,
  RECORD_FIELD_VISIBILITIES,
  RECORD_SUBJECT_KINDS,
} from "@studafy/records";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const recordSubjectKindSchema = z.enum(RECORD_SUBJECT_KINDS).openapi("RecordSubjectKind", {
  description: "Whose record: a student, a parent, a member of staff, or a class.",
});

export const recordFieldTypeSchema = z.enum(RECORD_FIELD_TYPES).openapi("RecordFieldType", {
  description: "What kind of answer a field takes. A document field takes an uploaded file.",
});

export const recordFieldVisibilitySchema = z
  .enum(RECORD_FIELD_VISIBILITIES)
  .openapi("RecordFieldVisibility", {
    description:
      "Who besides school leadership reads the field. A widening ladder: staff_only < finance < " +
      "teachers < parent, so a teachers field is also read by finance, and a parent field by " +
      "teachers and finance. Sensitive fields are read by leadership only, whatever this says.",
  });

export const recordFieldSensitivitySchema = z
  .enum(RECORD_FIELD_SENSITIVITIES)
  .openapi("RecordFieldSensitivity", {
    description:
      "sensitive: encrypted at rest, masked in every response, revealed in full only through the " +
      "audited reveal call (studentRecord:readSensitive), and deleted by the retention job.",
  });

export const recordDocumentStatusSchema = z
  .enum(RECORD_DOCUMENT_STATUSES)
  .openapi("RecordDocumentStatus", { description: "Where a document field stands." });

export const recordFieldOptionSchema = z
  .object({
    value: z.string().trim().min(1).max(100),
    label_en: z.string().trim().min(1).max(200),
    label_ar: z.string().trim().min(1).max(200),
  })
  .openapi("RecordFieldOption");

export const recordValueSchema = z
  .union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(100)).max(100)])
  .openapi("RecordValue", {
    description:
      "One answer: text, number, ISO date (YYYY-MM-DD), a choice value, a list of choice values, " +
      "or yes/no, depending on the field type.",
  });

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const subjectKindParamSchema = z
  .object({
    subjectKind: recordSubjectKindSchema.openapi({
      param: { name: "subjectKind", in: "path" },
    }),
  })
  .openapi("RecordSubjectKindParam");

export const templateFieldParamSchema = z
  .object({
    subjectKind: recordSubjectKindSchema.openapi({
      param: { name: "subjectKind", in: "path" },
    }),
    fieldId: uuidSchema.openapi({ param: { name: "fieldId", in: "path" } }),
  })
  .openapi("RecordTemplateFieldParam");

export const studentRecordParamSchema = z
  .object({
    studentId: uuidSchema.openapi({ param: { name: "studentId", in: "path" } }),
  })
  .openapi("StudentRecordParam");

export const studentRecordFieldParamSchema = z
  .object({
    studentId: uuidSchema.openapi({ param: { name: "studentId", in: "path" } }),
    fieldId: uuidSchema.openapi({ param: { name: "fieldId", in: "path" } }),
  })
  .openapi("StudentRecordFieldParam");

export const parentRecordParamSchema = z
  .object({
    parentUserId: uuidSchema.openapi({ param: { name: "parentUserId", in: "path" } }),
  })
  .openapi("ParentRecordParam");

export const parentRecordFieldParamSchema = z
  .object({
    parentUserId: uuidSchema.openapi({ param: { name: "parentUserId", in: "path" } }),
    fieldId: uuidSchema.openapi({ param: { name: "fieldId", in: "path" } }),
  })
  .openapi("ParentRecordFieldParam");

export const staffRecordParamSchema = z
  .object({
    staffUserId: uuidSchema.openapi({ param: { name: "staffUserId", in: "path" } }),
  })
  .openapi("StaffRecordParam");

export const staffRecordFieldParamSchema = z
  .object({
    staffUserId: uuidSchema.openapi({ param: { name: "staffUserId", in: "path" } }),
    fieldId: uuidSchema.openapi({ param: { name: "fieldId", in: "path" } }),
  })
  .openapi("StaffRecordFieldParam");

export const classRecordParamSchema = z
  .object({
    classId: uuidSchema.openapi({ param: { name: "classId", in: "path" } }),
  })
  .openapi("ClassRecordParam");

export const classRecordFieldParamSchema = z
  .object({
    classId: uuidSchema.openapi({ param: { name: "classId", in: "path" } }),
    fieldId: uuidSchema.openapi({ param: { name: "fieldId", in: "path" } }),
  })
  .openapi("ClassRecordFieldParam");

export const selfRecordFieldParamSchema = z
  .object({
    fieldId: uuidSchema.openapi({ param: { name: "fieldId", in: "path" } }),
  })
  .openapi("SelfRecordFieldParam");

// ---------------------------------------------------------------------------
// Template editor
// ---------------------------------------------------------------------------

export const recordTemplateFieldSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Stable field id. Answers keep it across versions." }),
    field_type: recordFieldTypeSchema,
    label_en: z.string(),
    label_ar: z.string(),
    help_en: z.string().nullable(),
    help_ar: z.string().nullable(),
    required: z.boolean(),
    options: z.array(recordFieldOptionSchema),
    sort_order: z.number().int(),
    visibility: recordFieldVisibilitySchema,
    sensitivity: recordFieldSensitivitySchema,
    has_expiry: z.boolean(),
    retention_months: z.number().int().nullable().openapi({
      description: "The school's own retention period for a sensitive field; null = the default.",
    }),
    effective_retention_months: z.number().int().nullable().openapi({
      description: "Months after the person leaves before a sensitive answer is deleted.",
    }),
    archived: z.boolean().openapi({
      description: "Removed from the form at the next publish. Its answers are kept.",
    }),
    published: z.boolean().openapi({
      description: "Published at least once: its type can no longer change.",
    }),
    label_suggests_sensitive: z.boolean().openapi({
      description: "Hint: the label reads like an ID number, passport or medical information.",
    }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("RecordTemplateField");

export const recordTemplateSchema = z
  .object({
    subject_kind: recordSubjectKindSchema,
    published_version: z.number().int().openapi({ description: "0 until the first publish." }),
    published_at: dateTimeSchema.nullable(),
    has_unpublished_changes: z.boolean(),
    fields: z.array(recordTemplateFieldSchema),
  })
  .openapi("RecordTemplate");

const fieldDefinitionShape = {
  label_en: z.string().trim().min(1).max(200),
  label_ar: z.string().trim().min(1).max(200),
  help_en: z.string().trim().max(1000).nullable().optional(),
  help_ar: z.string().trim().max(1000).nullable().optional(),
  required: z.boolean().optional(),
  options: z.array(recordFieldOptionSchema).max(100).optional(),
  visibility: recordFieldVisibilitySchema.optional(),
  sensitivity: recordFieldSensitivitySchema.optional(),
  has_expiry: z.boolean().optional(),
  retention_months: z
    .number()
    .int()
    .min(MIN_RETENTION_MONTHS)
    .max(MAX_RETENTION_MONTHS)
    .nullable()
    .optional(),
};

export const createRecordFieldBodySchema = z
  .object({ field_type: recordFieldTypeSchema, ...fieldDefinitionShape })
  .openapi("CreateRecordFieldBody");

export const updateRecordFieldBodySchema = z
  .object({
    field_type: recordFieldTypeSchema.optional(),
    ...fieldDefinitionShape,
    label_en: fieldDefinitionShape.label_en.optional(),
    label_ar: fieldDefinitionShape.label_ar.optional(),
    archived: z.boolean().optional(),
  })
  .openapi("UpdateRecordFieldBody");

export const reorderRecordFieldsBodySchema = z
  .object({ field_ids: z.array(uuidSchema).min(1).max(500) })
  .openapi("ReorderRecordFieldsBody");

export const recordTemplateVersionSchema = z
  .object({
    subject_kind: recordSubjectKindSchema,
    version: z.number().int(),
    published_at: dateTimeSchema,
    field_count: z.number().int(),
  })
  .openapi("RecordTemplateVersion");

// ---------------------------------------------------------------------------
// Filling in
// ---------------------------------------------------------------------------

export const recordFieldDefinitionSchema = z
  .object({
    id: uuidSchema,
    field_type: recordFieldTypeSchema,
    label_en: z.string(),
    label_ar: z.string(),
    help_en: z.string().nullable(),
    help_ar: z.string().nullable(),
    required: z.boolean(),
    options: z.array(recordFieldOptionSchema),
    sort_order: z.number().int(),
    visibility: recordFieldVisibilitySchema,
    sensitivity: recordFieldSensitivitySchema,
    has_expiry: z.boolean(),
  })
  .openapi("RecordFieldDefinition");

export const recordFormSchema = z
  .object({
    subject_kind: recordSubjectKindSchema,
    version: z.number().int().openapi({ description: "0 when nothing is published yet." }),
    fields: z.array(recordFieldDefinitionSchema),
  })
  .openapi("RecordForm");

export const recordDocumentSchema = z
  .object({
    status: recordDocumentStatusSchema,
    file_name: z.string().nullable(),
    content_type: z.string().nullable(),
    size_bytes: z.number().int().nullable(),
    sensitive: z.boolean().openapi({
      description: "Stored under the sensitive content class; downloading it is an audited reveal.",
    }),
    uploaded_at: dateTimeSchema.nullable(),
    verified_at: dateTimeSchema.nullable(),
    expires_on: dateSchema.nullable(),
    expiry_state: z.enum(["none", "valid", "expiring", "expired"]).openapi({
      description: "expiring = within 30 days.",
    }),
  })
  .openapi("RecordDocument");

export const recordEntrySchema = z
  .object({
    field: recordFieldDefinitionSchema,
    archived: z.boolean().openapi({
      description: "No longer on the published form; the answer is kept and shown to leadership.",
    }),
    value: recordValueSchema.nullable().openapi({
      description: "The answer. Always null for a sensitive field: see mask, and the reveal call.",
    }),
    masked: z.boolean(),
    mask: z
      .string()
      .nullable()
      .openapi({ description: "A sensitive answer's mask, e.g. •••• 1234." }),
    answered: z.boolean(),
    missing: z.boolean().openapi({ description: "Required, and not answered (or no file)." }),
    answered_in_version: z.number().int().nullable(),
    answered_field: recordFieldDefinitionSchema.nullable().openapi({
      description:
        "The field as it read when this answer was given, when that differs from the current form.",
    }),
    document: recordDocumentSchema.nullable(),
    updated_at: dateTimeSchema.nullable(),
  })
  .openapi("RecordEntry");

export const subjectRecordsSchema = z
  .object({
    subject_kind: recordSubjectKindSchema,
    subject_id: uuidSchema,
    template_version: z.number().int(),
    entries: z.array(recordEntrySchema),
    missing_required: z.number().int(),
  })
  .openapi("SubjectRecords");

export const recordAnswerInputSchema = z
  .object({
    field_id: uuidSchema,
    value: recordValueSchema.nullable().openapi({ description: "null clears the answer." }),
  })
  .openapi("RecordAnswerInput");

export const updateRecordsBodySchema = z
  .object({ answers: z.array(recordAnswerInputSchema).min(1).max(200) })
  .openapi("UpdateRecordsBody");

export const revealedRecordValueSchema = z
  .object({ field_id: uuidSchema, value: recordValueSchema.nullable() })
  .openapi("RevealedRecordValue");

export const attachRecordDocumentBodySchema = z
  .object({
    storage_key: z
      .string()
      .min(1)
      .max(1024)
      .openapi({
        description:
          "The temp/ key from POST /api/storage/uploads with content class record.document " +
          "(record.sensitiveDocument for a sensitive field).",
      }),
    checksum_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    expires_on: dateSchema.nullable().optional(),
  })
  .openapi("AttachRecordDocumentBody");

export const updateRecordDocumentBodySchema = z
  .object({
    status: z.enum(["uploaded", "verified"]).optional().openapi({
      description: "verified marks the file checked; uploaded withdraws a verification.",
    }),
    expires_on: dateSchema.nullable().optional(),
  })
  .openapi("UpdateRecordDocumentBody");

export const recordDocumentDownloadSchema = z
  .object({ url: z.string().url(), expires_at: dateTimeSchema })
  .openapi("RecordDocumentDownload");

// ---------------------------------------------------------------------------
// Missing information
// ---------------------------------------------------------------------------

export const recordMissingIssueSchema = z
  .enum(["all", "missing", "expired", "expiring"])
  .openapi("RecordMissingIssue", {
    description:
      "all: any issue; missing: a required field or document with no answer; expired: a " +
      "document past its expiry date; expiring: a document that expires within 30 days.",
  });

export const recordMissingQuerySchema = z
  .object({
    search: z
      .string()
      .trim()
      .max(120)
      .optional()
      .openapi({
        description:
          "A student's name or admission number, a parent's or staff member's name or email, or a " +
          "class's code or course name.",
      }),
    issue: recordMissingIssueSchema.default("all"),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("RecordMissingQuery");

export const recordMissingFieldSchema = z
  .object({
    field_id: uuidSchema,
    label_en: z.string(),
    label_ar: z.string(),
    expires_on: dateSchema.nullable(),
  })
  .openapi("RecordMissingField");

export const recordMissingStudentSchema = z
  .object({
    student_id: uuidSchema,
    name: z.string(),
    admission_number: z.string(),
    missing: z.array(recordMissingFieldSchema),
    expired: z.array(recordMissingFieldSchema),
    expiring: z.array(recordMissingFieldSchema),
  })
  .openapi("RecordMissingStudent");

export const recordMissingParentSchema = z
  .object({
    user_id: uuidSchema,
    name: z.string(),
    email: z.string().nullable(),
    missing: z.array(recordMissingFieldSchema),
    expired: z.array(recordMissingFieldSchema),
    expiring: z.array(recordMissingFieldSchema),
  })
  .openapi("RecordMissingParent");

export const recordMissingStaffSchema = z
  .object({
    user_id: uuidSchema,
    name: z.string(),
    email: z.string().nullable(),
    missing: z.array(recordMissingFieldSchema),
    expired: z.array(recordMissingFieldSchema),
    expiring: z.array(recordMissingFieldSchema),
  })
  .openapi("RecordMissingStaff");

export const recordMissingClassSchema = z
  .object({
    class_id: uuidSchema,
    code: z.string(),
    course_name: z.string(),
    missing: z.array(recordMissingFieldSchema),
    expired: z.array(recordMissingFieldSchema),
    expiring: z.array(recordMissingFieldSchema),
  })
  .openapi("RecordMissingClass");

export const recordMissingStudentListSchema = z
  .object({
    students: z.array(recordMissingStudentSchema),
    total: z.number().int(),
    issue: recordMissingIssueSchema,
  })
  .openapi("RecordMissingStudentList");

export const recordMissingParentListSchema = z
  .object({
    parents: z.array(recordMissingParentSchema),
    total: z.number().int(),
    issue: recordMissingIssueSchema,
  })
  .openapi("RecordMissingParentList");

export const recordMissingStaffListSchema = z
  .object({
    staff: z.array(recordMissingStaffSchema),
    total: z.number().int(),
    issue: recordMissingIssueSchema,
  })
  .openapi("RecordMissingStaffList");

export const recordMissingClassListSchema = z
  .object({
    classes: z.array(recordMissingClassSchema),
    total: z.number().int(),
    issue: recordMissingIssueSchema,
  })
  .openapi("RecordMissingClassList");

export const recordMissingSummarySchema = z
  .object({
    students: z.number().int().openapi({ description: "Students with at least one issue." }),
    parents: z.number().int().openapi({ description: "Parents with at least one issue." }),
    expired_documents: z.number().int(),
    expiring_documents: z.number().int(),
  })
  .openapi("RecordMissingSummary");

// ---------------------------------------------------------------------------
// Imported columns kept as record fields (staff and class CSV imports)
// ---------------------------------------------------------------------------

/** The subjects whose CSV imports run in the browser: the users (staff) and classes imports. */
export const recordImportSubjectKindSchema = z
  .enum(["staff", "class"])
  .openapi("RecordImportSubjectKind");

export const recordImportParamSchema = z
  .object({
    subjectKind: recordImportSubjectKindSchema.openapi({
      param: { name: "subjectKind", in: "path" },
    }),
  })
  .openapi("RecordImportParam");

/** Field types a column of text can fill: every type but document. */
export const recordColumnFieldTypeSchema = z
  .enum([
    "short_text",
    "long_text",
    "number",
    "date",
    "single_choice",
    "multi_choice",
    "yes_no",
    "phone",
    "email",
  ])
  .openapi("RecordColumnFieldType");

const recordImportNewFieldSchema = z
  .object({
    label_en: z.string().trim().min(1).max(200),
    label_ar: z.string().trim().min(1).max(200),
    // The enum as is: a description here would wrap the $ref, which the Dart client generator turns
    // into a class it cannot compile. The object's description says what omitting it means.
    field_type: recordColumnFieldTypeSchema.optional(),
    options: z.array(recordFieldOptionSchema).max(100).optional(),
    sensitivity: recordFieldSensitivitySchema.optional(),
    visibility: recordFieldVisibilitySchema.default("staff_only"),
  })
  .openapi("RecordImportNewField", {
    description:
      "A record field to create (and publish) from the column. Omit field_type to have it " +
      "guessed from the column's header and values (with its choices for a choice field, and " +
      "sensitivity suggested for ID-, medical- or pay-like data).",
  });

const recordImportColumnShape = {
  header: z.string().trim().min(1).max(500).openapi({
    description: "The column's header in the imported file.",
  }),
  field_id: uuidSchema.optional().openapi({
    description: "An existing field on the published form. Give this or new_field.",
  }),
  new_field: recordImportNewFieldSchema.optional(),
  overwrite: z.boolean().default(false).openapi({
    description: "Replace a different answer the subject already has. Default: keep it.",
  }),
  rows: z
    .array(
      z.object({
        line: z.number().int().min(2).openapi({ description: "The line in the file." }),
        subject_id: uuidSchema.openapi({
          description:
            "The id the create call for this line returned: a user (staff) or a class. Only " +
            "subjects the caller created in the last 24 hours are written.",
        }),
        value: z.string().max(10_000),
      }),
    )
    .min(1)
    .max(1_000),
};

const oneRecordImportTarget = {
  check: (body: { field_id?: string; new_field?: unknown }) =>
    (body.field_id === undefined) !== (body.new_field === undefined),
  message: "Give field_id or new_field, not both.",
};

export const recordImportColumnBodySchema = z
  .object(recordImportColumnShape)
  .refine(oneRecordImportTarget.check, { message: oneRecordImportTarget.message })
  .openapi("RecordImportColumnBody", {
    description:
      "One unknown column of a staff or class CSV import, the rows the import created with each " +
      "row's cell, and the record field to keep the column in.",
  });

export const applyRecordImportColumnBodySchema = z
  .object({
    ...recordImportColumnShape,
    preview_token: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .openapi({
        description: "The preview's token. A changed outcome since the preview is refused (409).",
      }),
  })
  .refine(oneRecordImportTarget.check, { message: oneRecordImportTarget.message })
  .openapi("ApplyRecordImportColumnBody", {
    description: "RecordImportColumnBody plus the preview's token.",
  });

const recordImportRowStatusValues = [
  "write",
  "unchanged",
  "kept",
  "invalid",
  "conflict",
  "skipped",
] as const;

export const recordImportPreviewRowSchema = z
  .object({
    line_number: z.number().int().positive(),
    subject_id: uuidSchema,
    name: z.string(),
    status: z.enum(recordImportRowStatusValues).openapi({
      description:
        "write: written. unchanged: already this value. kept: has a different answer, kept " +
        "(overwrite off). invalid: not a valid answer for the field. conflict: the line repeats a " +
        "subject with a different value. skipped: not a subject this import created (or, for " +
        "staff, not a member of staff). (Empty cells are counted, not listed.)",
    }),
    replaces_existing: z.boolean(),
    value: recordValueSchema.nullable().openapi({ description: "Null for a sensitive field." }),
    mask: z.string().nullable().openapi({ description: "A sensitive value's mask." }),
    current_value: recordValueSchema.nullable(),
    current_mask: z.string().nullable(),
    reason: z
      .enum([...RECORD_VALUE_ERRORS, "CONFLICTING_VALUES", "NOT_CREATED_BY_IMPORT", "NOT_STAFF"])
      .nullable()
      .openapi({ description: "Why invalid, conflict or skipped. Never the value." }),
  })
  .openapi("RecordImportPreviewRow");

const recordImportTotalsSchema = z
  .object({
    write: z.number().int(),
    unchanged: z.number().int(),
    kept: z.number().int(),
    invalid: z.number().int(),
    empty: z.number().int(),
    conflict: z.number().int(),
    skipped: z.number().int(),
  })
  .openapi("RecordImportTotals");

export const recordImportPreviewSchema = z
  .object({
    subject_kind: recordImportSubjectKindSchema,
    header: z.string(),
    field: z.object({
      id: uuidSchema.nullable().openapi({ description: "Null for a field to be created." }),
      field_type: recordColumnFieldTypeSchema,
      label_en: z.string(),
      label_ar: z.string(),
      options: z.array(recordFieldOptionSchema),
      sensitivity: recordFieldSensitivitySchema,
      visibility: recordFieldVisibilitySchema,
    }),
    suggested_sensitive: z.boolean().openapi({
      description:
        "The header or values look like an ID number, passport, medical or pay data. Always " +
        "false for a class, whose fields cannot be sensitive.",
    }),
    sensitive_reason: z.enum(["label", "values"]).nullable(),
    totals: recordImportTotalsSchema,
    rows: z.array(recordImportPreviewRowSchema),
    preview_token: z.string().openapi({ description: "Send back to apply exactly this outcome." }),
  })
  .openapi("RecordImportPreview");

export const recordImportApplyResultSchema = z
  .object({
    subject_kind: recordImportSubjectKindSchema,
    field_id: uuidSchema,
    field_created: z.boolean(),
    written: z.number().int(),
    totals: recordImportTotalsSchema,
  })
  .openapi("RecordImportApplyResult");

export type RecordImportColumnInput = z.infer<typeof recordImportColumnBodySchema>;
export type RecordImportPreview = z.infer<typeof recordImportPreviewSchema>;
export type RecordImportApplyResult = z.infer<typeof recordImportApplyResultSchema>;

export type RecordTemplateFieldDto = z.infer<typeof recordTemplateFieldSchema>;
export type RecordFieldDefinitionDto = z.infer<typeof recordFieldDefinitionSchema>;
export type RecordEntryDto = z.infer<typeof recordEntrySchema>;
export type SubjectRecordsDto = z.infer<typeof subjectRecordsSchema>;
export type RecordDocumentDto = z.infer<typeof recordDocumentSchema>;
export type RecordAnswerInput = z.infer<typeof recordAnswerInputSchema>;
export type RecordMissingIssue = z.infer<typeof recordMissingIssueSchema>;
