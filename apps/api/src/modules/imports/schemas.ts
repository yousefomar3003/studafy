import { z } from "@hono/zod-openapi";
import { RECORD_VALUE_ERRORS } from "@studafy/records";
import {
  STUDENT_IMPORT_FIELD_DEFINITIONS,
  STUDENT_IMPORT_FIELDS,
  UPDATABLE_STUDENT_FIELDS,
} from "@studafy/student-import";

import {
  recordFieldOptionSchema,
  recordFieldSensitivitySchema,
  recordFieldTypeSchema,
  recordFieldVisibilitySchema,
  recordValueSchema,
} from "../records/schemas";

import type { StudentImportField } from "@studafy/student-import";

// ---------------------------------------------------------------------------
// Import status
// ---------------------------------------------------------------------------

export const importStatusValues = [
  "uploaded",
  "validated",
  "confirmed",
  "processing",
  "completed",
  "failed",
] as const;

export const importStatusSchema = z
  .enum(importStatusValues)
  .openapi({ description: "Lifecycle state of the import." });

export type ImportStatus = z.infer<typeof importStatusSchema>;

// ---------------------------------------------------------------------------
// Import row error (one per malformed CSV row, or per mapping problem at the header line)
// ---------------------------------------------------------------------------

export const importRowErrorSchema = z
  .object({
    line: z.number().int().positive().openapi({ description: "1-based CSV line number." }),
    field: z.string().openapi({ description: "Import field the error is about." }),
    message: z.string().openapi({ description: "Human-readable error description." }),
  })
  .openapi("ImportRowError");

export type ImportRowError = z.infer<typeof importRowErrorSchema>;

// ---------------------------------------------------------------------------
// Import summary (populated after processing completes)
// ---------------------------------------------------------------------------

export const importSummarySchema = z
  .object({
    students_created: z.number().int().openapi({ description: "New student records created." }),
    students_updated: z.number().int().optional().openapi({
      description: "Existing students changed. Absent on imports completed before ST-299.",
    }),
    students_skipped: z
      .number()
      .int()
      .openapi({ description: "Rows not written: already up to date, or in conflict." }),
    conflicts: z.number().int().optional().openapi({
      description: "Rows skipped as conflicts. Absent on imports completed before ST-299.",
    }),
    parents_created: z.number().int().openapi({ description: "New parent user accounts created." }),
    parents_linked: z.number().int().openapi({ description: "Parent-child links created." }),
    parent_conflicts: z
      .number()
      .int()
      .optional()
      .openapi({
        description:
          "Rows whose parent_email already belonged to an account: the student was imported, the " +
          "parent not linked. Absent on imports completed before the change.",
      }),
    record_answers: z.number().int().optional().openapi({
      description: "Student record answers written from template columns.",
    }),
  })
  .openapi("ImportSummary");

export type ImportSummary = z.infer<typeof importSummarySchema>;

// ---------------------------------------------------------------------------
// Column mapping — import field -> source header
// ---------------------------------------------------------------------------

const columnMappingShape = Object.fromEntries(
  STUDENT_IMPORT_FIELDS.map((field) => {
    const { target, required } = STUDENT_IMPORT_FIELD_DEFINITIONS[field];
    return [
      field,
      z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .openapi({
          description: `Source column for ${field}; writes to ${target}${required ? "; required" : ""}.`,
        }),
    ];
  }),
) as Record<StudentImportField, z.ZodOptional<z.ZodString>>;

export const columnMappingSchema = z
  .object({
    ...columnMappingShape,
    records: z
      .record(z.string().uuid(), z.string().trim().min(1).max(200))
      .optional()
      .openapi({
        description:
          "Student record template fields (by field id) mapped to source columns. Document fields " +
          "cannot be imported; their files are uploaded on the Records tab.",
      }),
  })
  .strict()
  .openapi("StudentImportColumnMapping", {
    description:
      "Maps Studafy import fields to the header text of the uploaded CSV. Headers match " +
      "case-, spacing- and punctuation-insensitively.",
  });

// ---------------------------------------------------------------------------
// The original file
// ---------------------------------------------------------------------------

export const sourceRemovedReasonValues = ["deleted", "retention", "erasure"] as const;
export type SourceRemovedReason = (typeof sourceRemovedReasonValues)[number];

export const importSourceFileSchema = z
  .object({
    file_name: z.string().openapi({ description: "The uploaded file's name." }),
    size_bytes: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Stored size. Null once the file is removed." }),
    uploaded_at: z.string().datetime(),
    stored: z.boolean().openapi({ description: "Whether the file can still be downloaded." }),
    expires_at: z.string().datetime().nullable().openapi({
      description:
        "When the daily sweep deletes the file under the school's retention period. Null once removed.",
    }),
    removed_at: z.string().datetime().nullable(),
    removed_reason: z.enum(sourceRemovedReasonValues).nullable().openapi({
      description:
        "deleted: by staff. retention: the retention period ended. erasure: the school's closure.",
    }),
  })
  .openapi("ImportSourceFile", {
    description: "The original file a school uploaded, kept so nothing in it is lost.",
  });

// ---------------------------------------------------------------------------
// Import record
// ---------------------------------------------------------------------------

export const importRecordSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Import ID." }),
    school_id: z.string().uuid().openapi({ description: "Owning school." }),
    uploaded_by: z.string().uuid().openapi({ description: "User who uploaded the CSV." }),
    confirmed_by: z
      .string()
      .uuid()
      .nullable()
      .openapi({ description: "User who confirmed the import. Null until confirmed." }),
    status: importStatusSchema,
    file_name: z.string().openapi({ description: "Original CSV filename." }),
    row_count: z.number().int().openapi({ description: "Total data rows in the CSV." }),
    valid_rows: z.number().int().openapi({ description: "Rows that passed validation." }),
    error_rows: z.number().int().openapi({ description: "Rows that did not." }),
    header_line: z
      .number()
      .int()
      .positive()
      .openapi({ description: "1-based line the header row was detected on." }),
    source_headers: z
      .array(z.string())
      .openapi({ description: "The CSV's header row, as detected." }),
    column_mapping: columnMappingSchema,
    errors: z
      .array(importRowErrorSchema)
      .openapi({ description: "Mapping errors (at header_line) or row-level validation errors." }),
    summary: importSummarySchema
      .nullable()
      .openapi({ description: "Processing summary. Null until completed." }),
    created_at: z.string().datetime().openapi({ description: "Upload timestamp." }),
    updated_at: z.string().datetime().openapi({ description: "Last state change." }),
    confirmed_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ description: "When the import was confirmed." }),
    completed_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ description: "When processing finished." }),
    source_file: importSourceFileSchema.nullable().openapi({
      description: "The original file. Null when none was kept (uploads before files were kept).",
    }),
  })
  .openapi("ImportRecord");

export type ImportRecordResponse = z.infer<typeof importRecordSchema>;

// ---------------------------------------------------------------------------
// Confirm body — idempotency key for re-run safety
// ---------------------------------------------------------------------------

export const confirmImportBodySchema = z
  .object({
    idempotency_key: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .openapi({
        description:
          "Optional idempotency key. If provided and an import with this key already completed, " +
          "the request is a no-op and returns the existing import.",
        example: "import-2024-01-15-batch1",
      }),
  })
  .openapi("ConfirmImportBody");

export type ConfirmImportBody = z.infer<typeof confirmImportBodySchema>;

// ---------------------------------------------------------------------------
// Upload query — optional saved mapping
// ---------------------------------------------------------------------------

export const uploadImportQuerySchema = z
  .object({
    mapping_id: z.string().uuid().optional().openapi({
      description:
        "A saved column mapping to apply. Omitted: a mapping is suggested from the headers.",
    }),
    source_key: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .openapi({
        description:
          "The temp/ storage key the same file was staged under (content class import.source). " +
          "The stored bytes must equal the request body; the file is then kept as the import's " +
          "original. Omitted: no original is kept (deployments without object storage).",
      }),
  })
  .openapi("UploadImportQuery");

// ---------------------------------------------------------------------------
// Re-map body
// ---------------------------------------------------------------------------

const mappingNameSchema = z.string().trim().min(1).max(100);

export const updateImportMappingBodySchema = z
  .object({
    column_mapping: columnMappingSchema,
    save_as: mappingNameSchema
      .optional()
      .openapi({ description: "Also save this mapping for the school under this name." }),
  })
  .openapi("UpdateImportMappingBody");

// ---------------------------------------------------------------------------
// Import list query
// ---------------------------------------------------------------------------

export const importListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    status: importStatusSchema.optional(),
  })
  .openapi("ImportListQuery");

// ---------------------------------------------------------------------------
// Import list response
// ---------------------------------------------------------------------------

export const importListItemSchema = importRecordSchema
  .extend({
    uploaded_by_name: z.string().nullable().openapi({ description: "Who uploaded the file." }),
    confirmed_by_name: z.string().nullable().openapi({ description: "Who confirmed the import." }),
    unmapped_column_count: z
      .number()
      .int()
      .openapi({ description: "Source columns no field read." }),
    cells_available: z.boolean().openapi({
      description:
        "Whether the import still holds cells (staged rows, or a completed import's leftover cells).",
    }),
  })
  .openapi("ImportListItem");

export const importListSchema = z
  .object({
    imports: z.array(importListItemSchema),
    next_cursor: z.string().nullable().openapi({
      description: "Opaque cursor for the next page. Null when no more results.",
    }),
  })
  .openapi("ImportList");

// ---------------------------------------------------------------------------
// Import path params
// ---------------------------------------------------------------------------

export const importIdParamSchema = z
  .object({
    importId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "importId", in: "path" },
        description: "Import UUID.",
      }),
  })
  .openapi("ImportIdParam");

// ---------------------------------------------------------------------------
// Saved mappings
// ---------------------------------------------------------------------------

export const studentImportMappingSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Saved mapping ID." }),
    name: z.string().openapi({ description: "Name, unique per school (case-insensitive)." }),
    column_mapping: columnMappingSchema,
    created_by: z.string().uuid().openapi({ description: "User who saved it." }),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("StudentImportMapping");

export type StudentImportMappingResponse = z.infer<typeof studentImportMappingSchema>;

export const studentImportMappingListSchema = z
  .object({ mappings: z.array(studentImportMappingSchema) })
  .openapi("StudentImportMappingList");

export const createStudentImportMappingBodySchema = z
  .object({ name: mappingNameSchema, column_mapping: columnMappingSchema })
  .openapi("CreateStudentImportMappingBody");

export const updateStudentImportMappingBodySchema = z
  .object({
    name: mappingNameSchema.optional(),
    column_mapping: columnMappingSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.column_mapping !== undefined, {
    message: "Provide name, column_mapping, or both.",
  })
  .openapi("UpdateStudentImportMappingBody");

export const mappingIdParamSchema = z
  .object({
    mappingId: z
      .string()
      .uuid()
      .openapi({ param: { name: "mappingId", in: "path" }, description: "Saved mapping UUID." }),
  })
  .openapi("StudentImportMappingIdParam");

// ---------------------------------------------------------------------------
// Dry-run diff
// ---------------------------------------------------------------------------

export const importDiffActionValues = ["create", "update", "unchanged", "conflict"] as const;
export const importDiffRecordValueSchema = z
  .object({
    field_id: z.string().uuid(),
    label_en: z.string(),
    label_ar: z.string(),
    value: recordValueSchema.nullable().openapi({ description: "Null for a sensitive field." }),
    mask: z
      .string()
      .nullable()
      .openapi({ description: "A sensitive field's mask, e.g. •••• 1234." }),
  })
  .openapi("ImportDiffRecordValue");

const fieldChangeSchema = z.object({ from: z.string().nullable(), to: z.string() });

export const importDiffRowSchema = z
  .object({
    line_number: z.number().int().positive().openapi({ description: "1-based CSV line number." }),
    admission_number: z.string(),
    action: z.enum(importDiffActionValues),
    conflict: z
      .enum([
        "DUPLICATE_ADMISSION_NUMBER_IN_FILE",
        "DUPLICATE_EMAIL_IN_FILE",
        "EMAIL_MISMATCH",
        "EMAIL_BELONGS_TO_OTHER_STUDENT",
        "EMAIL_BELONGS_TO_STAFF",
        "PARENT_EMAIL_BELONGS_TO_STUDENT",
      ])
      .nullable()
      .openapi({ description: "Why the row will be skipped. Null unless action is conflict." }),
    changes: z
      .object(
        Object.fromEntries(
          UPDATABLE_STUDENT_FIELDS.map((field) => [field, fieldChangeSchema.optional()]),
        ),
      )
      .openapi({ description: "Live student fields this row changes (from -> to)." }),
    parent: z
      .enum(["create", "sibling", "conflict"])
      .nullable()
      .openapi({
        description:
          "create: this line creates a new parent and household. sibling: an earlier line in this " +
          "file creates them and this student joins (see parent_group_line). conflict: the parent " +
          "is not linked (see parent_conflict). Null when the row names no parent.",
      }),
    parent_conflict: z
      .enum(["PARENT_ACCOUNT_EXISTS"])
      .nullable()
      .openapi({
        description:
          "PARENT_ACCOUNT_EXISTS: parent_email already belongs to an account. The student is still " +
          "imported, with no link; link the parent from the student's Guardians tab or Finance > " +
          "Unlinked. An import never matches people by email.",
      }),
    parent_group_line: z.number().int().positive().nullable().openapi({
      description:
        "The line that creates this row's new parent; equal to line_number on that line.",
    }),
    parent_email: z.string().nullable().openapi({ description: "The parent email as given." }),
    parent_name: z.string().nullable().openapi({ description: "The parent name as given." }),
    link: z
      .enum(["create"])
      .nullable()
      .openapi({ description: "create: a parent-student link is made. Null: no link." }),
    records: z
      .array(importDiffRecordValueSchema)
      .openapi({ description: "Template answers this row writes. Sensitive ones are masked." }),
  })
  .openapi("ImportDiffRow");

export const importDiffSchema = z
  .object({
    import_id: z.string().uuid(),
    totals: z
      .object({
        create: z.number().int(),
        update: z.number().int(),
        unchanged: z.number().int(),
        conflict: z.number().int(),
        parents_created: z.number().int(),
        links_created: z.number().int(),
        parent_conflicts: z.number().int().openapi({
          description: "Rows whose parent will not be linked (PARENT_ACCOUNT_EXISTS).",
        }),
      })
      .openapi({ description: "Counts over every valid row, regardless of the action filter." }),
    rows: z.array(importDiffRowSchema),
  })
  .openapi("ImportDiff");

export type ImportDiffResponse = z.infer<typeof importDiffSchema>;

export const importDiffQuerySchema = z
  .object({
    action: z
      .enum(importDiffActionValues)
      .optional()
      .openapi({ description: "Only return rows with this action." }),
  })
  .openapi("ImportDiffQuery");

// ---------------------------------------------------------------------------
// Original file download
// ---------------------------------------------------------------------------

export const importSourceDownloadSchema = z
  .object({
    url: z.string().url().openapi({ description: "Signed download URL." }),
    expires_at: z.string().datetime().openapi({ description: "When the URL stops working." }),
  })
  .openapi("ImportSourceDownload");

// ---------------------------------------------------------------------------
// Retention settings
// ---------------------------------------------------------------------------

export const importSettingsSchema = z
  .object({
    source_retention_days: z.number().int().openapi({
      description: "Days original files and leftover cells are kept after an upload.",
    }),
    default_retention_days: z.number().int(),
    max_retention_days: z.number().int().openapi({ description: "A school can only shorten it." }),
    updated_at: z.string().datetime().nullable(),
  })
  .openapi("ImportSettings");

export const updateImportSettingsBodySchema = z
  .object({ source_retention_days: z.number().int().min(1).max(180) })
  .openapi("UpdateImportSettingsBody");

// ---------------------------------------------------------------------------
// Unmapped columns
// ---------------------------------------------------------------------------

export const importableFieldTypeSchema = recordFieldTypeSchema.exclude(["document"]);

// Whose record a student import's column is written to. A student import creates students and
// parents only, so the staff and class kinds of RecordSubjectKind are not offered here.
export const importSubjectKindSchema = z.enum(["student", "parent"]).openapi("ImportSubjectKind");

export const unmappedColumnSchema = z
  .object({
    position: z.number().int().min(0).openapi({ description: "0-based index in source_headers." }),
    header: z.string(),
    non_empty_count: z.number().int().openapi({ description: "Lines with a value in the column." }),
    student_count: z.number().int().openapi({
      description: "Students this import created or updated that have a value in the column.",
    }),
    parent_count: z.number().int().openapi({
      description: "Parents this import created that have a value in the column.",
    }),
    suggested_field_type: importableFieldTypeSchema,
    suggested_options: z.array(recordFieldOptionSchema).openapi({
      description: "Choices for a suggested single_choice field.",
    }),
    suggested_sensitive: z.boolean().openapi({
      description: "The header or values look like an ID number, passport, medical or pay data.",
    }),
    sensitive_reason: z.enum(["label", "values"]).nullable(),
    applied: z
      .object({
        field_id: z.string().uuid(),
        subject_kind: importSubjectKindSchema,
        label_en: z.string(),
        label_ar: z.string(),
        count: z.number().int(),
        applied_at: z.string().datetime(),
        applied_by_name: z.string().nullable(),
      })
      .nullable()
      .openapi({ description: "The record field this column was last applied to." }),
  })
  .openapi("UnmappedColumn");

export const unmappedColumnsSchema = z
  .object({
    import_id: z.string().uuid(),
    status: importStatusSchema,
    cells_available: z.boolean(),
    can_apply: z.boolean().openapi({
      description: "Completed, and its leftover cells are still held: a column can be applied.",
    }),
    cells_expire_at: z.string().datetime().nullable().openapi({
      description: "When the leftover cells are deleted under the school's retention period.",
    }),
    columns: z.array(unmappedColumnSchema),
  })
  .openapi("UnmappedColumns");

export type UnmappedColumnsResponse = z.infer<typeof unmappedColumnsSchema>;

const newFieldSchema = z
  .object({
    label_en: z.string().trim().min(1).max(200),
    label_ar: z.string().trim().min(1).max(200),
    field_type: importableFieldTypeSchema,
    options: z.array(recordFieldOptionSchema).max(100).default([]),
    sensitivity: recordFieldSensitivitySchema.default("standard"),
    visibility: recordFieldVisibilitySchema.default("staff_only"),
  })
  .openapi("ImportColumnNewField", {
    description: "A record field to create (and publish) from the column.",
  });

const columnTargetShape = {
  position: z.number().int().min(0).openapi({ description: "The unmapped column's position." }),
  // The enum as is: a description here would wrap the $ref, which the Dart client generator turns
  // into a class it cannot compile. The body schema's description says what it means.
  subject_kind: importSubjectKindSchema,
  field_id: z.string().uuid().optional().openapi({
    description: "An existing field on the published form. Give this or new_field.",
  }),
  new_field: newFieldSchema.optional(),
  overwrite: z.boolean().default(false).openapi({
    description: "Replace a different answer a person already has. Default: keep it.",
  }),
};

const oneTarget = {
  check: (body: { field_id?: string; new_field?: unknown }) =>
    (body.field_id === undefined) !== (body.new_field === undefined),
  message: "Give field_id or new_field, not both.",
};

export const columnTargetBodySchema = z
  .object(columnTargetShape)
  .refine(oneTarget.check, { message: oneTarget.message })
  .openapi("ImportColumnTarget", {
    description:
      "A column and the record field to write it to. subject_kind student: the students this " +
      "import created or updated; parent: the parents it created.",
  });

export type ColumnTargetInput = z.infer<typeof columnTargetBodySchema>;

export const applyColumnBodySchema = z
  .object({
    ...columnTargetShape,
    preview_token: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .openapi({
        description: "The preview's token. A changed outcome since the preview is refused (409).",
      }),
  })
  .refine(oneTarget.check, { message: oneTarget.message })
  .openapi("ApplyImportColumnBody", {
    description: "ImportColumnTarget plus the preview's token.",
  });

export const columnPreviewStatusValues = [
  "write",
  "unchanged",
  "kept",
  "invalid",
  "empty",
  "conflict",
] as const;
export type ColumnPreviewStatus = (typeof columnPreviewStatusValues)[number];

export const columnPreviewRowSchema = z
  .object({
    line_number: z.number().int().positive(),
    subject_id: z.string().uuid(),
    name: z.string(),
    admission_number: z.string().nullable(),
    status: z.enum(columnPreviewStatusValues).openapi({
      description:
        "write: written. unchanged: already this value. kept: has a different answer, kept " +
        "(overwrite off). invalid: not a valid answer for the field. conflict: a parent's siblings " +
        "disagree. (empty: nothing in the cell; counted, not listed.)",
    }),
    replaces_existing: z.boolean(),
    value: recordValueSchema.nullable().openapi({ description: "Null for a sensitive field." }),
    mask: z.string().nullable().openapi({ description: "A sensitive value's mask." }),
    current_value: recordValueSchema.nullable(),
    current_mask: z.string().nullable(),
    reason: z
      .enum([...RECORD_VALUE_ERRORS, "CONFLICTING_VALUES"])
      .nullable()
      .openapi({ description: "Why invalid or conflict. Names the rule, never the value." }),
  })
  .openapi("ImportColumnPreviewRow");

export type ColumnPreviewRow = z.infer<typeof columnPreviewRowSchema>;

const columnTotalsSchema = z.object({
  write: z.number().int(),
  unchanged: z.number().int(),
  kept: z.number().int(),
  invalid: z.number().int(),
  empty: z.number().int(),
  conflict: z.number().int(),
});

export const importColumnPreviewSchema = z
  .object({
    import_id: z.string().uuid(),
    position: z.number().int(),
    header: z.string(),
    subject_kind: importSubjectKindSchema,
    field: z.object({
      id: z.string().uuid().nullable().openapi({ description: "Null for a field to be created." }),
      field_type: importableFieldTypeSchema,
      label_en: z.string(),
      label_ar: z.string(),
      sensitivity: recordFieldSensitivitySchema,
    }),
    totals: columnTotalsSchema,
    rows: z.array(columnPreviewRowSchema),
    preview_token: z.string().openapi({ description: "Send back to apply exactly this outcome." }),
  })
  .openapi("ImportColumnPreview");

export type ImportColumnPreview = z.infer<typeof importColumnPreviewSchema>;

export const columnApplyResultSchema = z
  .object({
    import_id: z.string().uuid(),
    position: z.number().int(),
    field_id: z.string().uuid(),
    field_created: z.boolean(),
    written: z.number().int(),
    totals: columnTotalsSchema,
  })
  .openapi("ImportColumnApplyResult");

export type ColumnApplyResult = z.infer<typeof columnApplyResultSchema>;

// ---------------------------------------------------------------------------
// Platform product signal
// ---------------------------------------------------------------------------

export const unmappedHeaderSignalSchema = z
  .object({
    min_schools: z.number().int().openapi({
      description: "A header is listed only once this many schools have brought it.",
    }),
    headers: z.array(
      z.object({
        normalized_header: z.string(),
        header: z.string().openapi({ description: "Its most common spelling." }),
        schools: z.number().int(),
        imports: z.number().int(),
      }),
    ),
  })
  .openapi("UnmappedHeaderSignal", {
    description: "Unmapped import column headers across schools. Header text and counts only.",
  });

export type UnmappedHeaderSignal = z.infer<typeof unmappedHeaderSignalSchema>;
