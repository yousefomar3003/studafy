import { z } from "@hono/zod-openapi";
import {
  MAX_RETENTION_MONTHS,
  MIN_RETENTION_MONTHS,
  RECORD_DOCUMENT_STATUSES,
  RECORD_FIELD_SENSITIVITIES,
  RECORD_FIELD_TYPES,
  RECORD_FIELD_VISIBILITIES,
  RECORD_SUBJECT_KINDS,
} from "@studafy/records";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const recordSubjectKindSchema = z
  .enum(RECORD_SUBJECT_KINDS)
  .openapi("RecordSubjectKind", { description: "Whose record: a student, or a parent." });

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
    search: z.string().trim().max(120).optional().openapi({
      description: "A student's name or admission number, or a parent's name or email.",
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

export const recordMissingSummarySchema = z
  .object({
    students: z.number().int().openapi({ description: "Students with at least one issue." }),
    parents: z.number().int().openapi({ description: "Parents with at least one issue." }),
    expired_documents: z.number().int(),
    expiring_documents: z.number().int(),
  })
  .openapi("RecordMissingSummary");

export type RecordTemplateFieldDto = z.infer<typeof recordTemplateFieldSchema>;
export type RecordFieldDefinitionDto = z.infer<typeof recordFieldDefinitionSchema>;
export type RecordEntryDto = z.infer<typeof recordEntrySchema>;
export type SubjectRecordsDto = z.infer<typeof subjectRecordsSchema>;
export type RecordDocumentDto = z.infer<typeof recordDocumentSchema>;
export type RecordAnswerInput = z.infer<typeof recordAnswerInputSchema>;
export type RecordMissingIssue = z.infer<typeof recordMissingIssueSchema>;
