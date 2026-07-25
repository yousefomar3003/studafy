import { z } from "@hono/zod-openapi";

import { studentStatusSchema } from "../users/schemas";

// ---------------------------------------------------------------------------
// CSV row schema — the shape of one parsed CSV row
// ---------------------------------------------------------------------------

export const csvStudentRowSchema = z.object({
  admission_number: z.string().min(1).max(100),
  email: z.string().email().max(320),
  first_name: z.string().min(1).max(100),
  middle_name: z.string().max(100).optional().nullable(),
  last_name: z.string().min(1).max(100),
  preferred_name: z.string().max(100).optional().nullable(),
  date_of_birth: z.string().date().optional().nullable(),
  status: studentStatusSchema.default("applicant"),
  parent_email: z.string().email().max(320).optional().nullable(),
  parent_relationship: z
    .enum(["mother", "father", "guardian", "step_parent", "grandparent", "sibling", "other"])
    .optional()
    .nullable(),
});

export type CsvStudentRow = z.infer<typeof csvStudentRowSchema>;

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
// Import row error (one per malformed CSV row)
// ---------------------------------------------------------------------------

export const importRowErrorSchema = z
  .object({
    line: z.number().int().positive().openapi({ description: "1-based CSV line number." }),
    field: z.string().openapi({ description: "Column name with the error." }),
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
    students_skipped: z
      .number()
      .int()
      .openapi({ description: "Rows skipped (duplicate admission)." }),
    parents_created: z.number().int().openapi({ description: "New parent user accounts created." }),
    parents_linked: z.number().int().openapi({ description: "Parent-child links created." }),
  })
  .openapi("ImportSummary");

export type ImportSummary = z.infer<typeof importSummarySchema>;

// ---------------------------------------------------------------------------
// Import record
// ---------------------------------------------------------------------------

export const importRecordSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Import ID." }),
    school_id: z.string().uuid().openapi({ description: "Owning school." }),
    uploaded_by: z.string().uuid().openapi({ description: "User who uploaded the CSV." }),
    status: importStatusSchema,
    file_name: z.string().openapi({ description: "Original CSV filename." }),
    row_count: z.number().int().openapi({ description: "Total rows in the CSV." }),
    valid_rows: z.number().int().openapi({ description: "Rows that passed validation." }),
    error_rows: z.number().int().openapi({ description: "Rows with validation errors." }),
    errors: z.array(importRowErrorSchema).openapi({ description: "Row-level validation errors." }),
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
