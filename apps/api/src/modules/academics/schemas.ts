import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema, dateSchema } from "@studafy/shared-schemas";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const academicYearStatusSchema = z
  .enum(["planned", "active", "closed", "archived"])
  .openapi({ description: "Lifecycle state of an academic year." });

export type AcademicYearStatus = z.infer<typeof academicYearStatusSchema>;

// ---------------------------------------------------------------------------
// Academic Year
// ---------------------------------------------------------------------------

export const academicYearSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    code: z
      .string()
      .openapi({ description: "Short unique code within the school.", example: "2025-2026" }),
    name: z
      .string()
      .openapi({ description: "Human-readable name.", example: "Academic Year 2025-2026" }),
    starts_on: dateSchema.openapi({ description: "First day of the academic year." }),
    ends_on: dateSchema.openapi({ description: "Last day of the academic year." }),
    status: academicYearStatusSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("AcademicYear");

export type AcademicYear = z.infer<typeof academicYearSchema>;

export const createAcademicYearBodySchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(50)
      .openapi({ description: "Short unique code.", example: "2025-2026" }),
    name: z
      .string()
      .min(1)
      .max(200)
      .openapi({ description: "Human-readable name.", example: "Academic Year 2025-2026" }),
    starts_on: z.string().date().openapi({ description: "First day (YYYY-MM-DD)." }),
    ends_on: z
      .string()
      .date()
      .openapi({ description: "Last day (YYYY-MM-DD). Must be after starts_on." }),
    status: academicYearStatusSchema.default("planned"),
  })
  .openapi("CreateAcademicYearBody");

export type CreateAcademicYearBody = z.infer<typeof createAcademicYearBodySchema>;

export const updateAcademicYearBodySchema = z
  .object({
    code: z.string().min(1).max(50).optional().openapi({ description: "Short unique code." }),
    name: z.string().min(1).max(200).optional().openapi({ description: "Human-readable name." }),
    starts_on: z.string().date().optional().openapi({ description: "First day (YYYY-MM-DD)." }),
    ends_on: z.string().date().optional().openapi({ description: "Last day (YYYY-MM-DD)." }),
    status: academicYearStatusSchema.optional(),
  })
  .openapi("UpdateAcademicYearBody");

export type UpdateAcademicYearBody = z.infer<typeof updateAcademicYearBodySchema>;

export const academicYearListSchema = z
  .object({
    academic_years: z.array(academicYearSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("AcademicYearList");

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export const termSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    academic_year_id: uuidSchema.openapi({ description: "Parent academic year." }),
    code: z
      .string()
      .openapi({ description: "Short unique code within the academic year.", example: "T1" }),
    name: z.string().openapi({ description: "Human-readable name.", example: "Term 1" }),
    sequence_number: z
      .number()
      .int()
      .openapi({ description: "Ordinal position within the year.", example: 1 }),
    starts_on: dateSchema.openapi({ description: "First day of the term." }),
    ends_on: dateSchema.openapi({ description: "Last day of the term." }),
    status: academicYearStatusSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Term");

export type Term = z.infer<typeof termSchema>;

export const createTermBodySchema = z
  .object({
    academic_year_id: uuidSchema.openapi({ description: "Parent academic year." }),
    code: z.string().min(1).max(50).openapi({ description: "Short unique code.", example: "T1" }),
    name: z
      .string()
      .min(1)
      .max(200)
      .openapi({ description: "Human-readable name.", example: "Term 1" }),
    sequence_number: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "Ordinal position (1-based)." }),
    starts_on: z.string().date().openapi({ description: "First day (YYYY-MM-DD)." }),
    ends_on: z.string().date().openapi({ description: "Last day (YYYY-MM-DD)." }),
    status: academicYearStatusSchema.default("planned"),
  })
  .openapi("CreateTermBody");

export type CreateTermBody = z.infer<typeof createTermBodySchema>;

export const updateTermBodySchema = z
  .object({
    code: z.string().min(1).max(50).optional().openapi({ description: "Short unique code." }),
    name: z.string().min(1).max(200).optional().openapi({ description: "Human-readable name." }),
    sequence_number: z
      .number()
      .int()
      .min(1)
      .optional()
      .openapi({ description: "Ordinal position." }),
    starts_on: z.string().date().optional().openapi({ description: "First day (YYYY-MM-DD)." }),
    ends_on: z.string().date().optional().openapi({ description: "Last day (YYYY-MM-DD)." }),
    status: academicYearStatusSchema.optional(),
  })
  .openapi("UpdateTermBody");

export type UpdateTermBody = z.infer<typeof updateTermBodySchema>;

export const termListSchema = z
  .object({
    terms: z.array(termSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("TermList");

// ---------------------------------------------------------------------------
// Rollover
// ---------------------------------------------------------------------------

export const rolloverResponseSchema = z
  .object({
    prior_year_id: uuidSchema.nullable().openapi({
      description: "ID of the previously active year, or null if none existed.",
    }),
    prior_year_status: academicYearStatusSchema.nullable().openapi({
      description: "Status the prior year was set to, or null.",
    }),
    new_year_id: uuidSchema.openapi({ description: "ID of the newly activated year." }),
    new_year_status: z.literal("active").openapi({ description: "The target year is now active." }),
    enrollments_archived: z.number().int().openapi({
      description: "Number of enrollments transitioned to completed.",
    }),
  })
  .openapi("RolloverResult");

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const yearIdParamSchema = z
  .object({
    yearId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "yearId", in: "path" },
        description: "Academic year UUID.",
      }),
  })
  .openapi("YearIdParam");

export const termIdParamSchema = z
  .object({
    termId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "termId", in: "path" },
        description: "Term UUID.",
      }),
  })
  .openapi("TermIdParam");

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

export const academicYearQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    status: academicYearStatusSchema.optional(),
  })
  .openapi("AcademicYearQuery");

export const termQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    status: academicYearStatusSchema.optional(),
  })
  .openapi("TermQuery");
