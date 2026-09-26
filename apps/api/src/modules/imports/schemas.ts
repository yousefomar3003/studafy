import { z } from "@hono/zod-openapi";
import {
  STUDENT_IMPORT_FIELD_DEFINITIONS,
  STUDENT_IMPORT_FIELDS,
  UPDATABLE_STUDENT_FIELDS,
} from "@studafy/student-import";

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
  .object(columnMappingShape)
  .strict()
  .openapi("StudentImportColumnMapping", {
    description:
      "Maps Studafy import fields to the header text of the uploaded CSV. Headers match " +
      "case-, spacing- and punctuation-insensitively.",
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

export const importListSchema = z
  .object({
    imports: z.array(importRecordSchema),
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
      .enum(["create", "existing"])
      .nullable()
      .openapi({ description: "Parent account outcome. Null when the row names no parent." }),
    link: z
      .enum(["create", "update", "unchanged"])
      .nullable()
      .openapi({ description: "Parent-student link outcome. Null when the row names no parent." }),
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
        links_updated: z.number().int(),
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
