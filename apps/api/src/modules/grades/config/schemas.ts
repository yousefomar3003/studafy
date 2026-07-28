import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

/**
 * Request and response schemas for the gradebook configuration API (ST-112).
 *
 * Assessment categories define weighted grading buckets (Homework 20%, Midterm 30%,
 * Final Exam 50%) per gradebook. Grading schemes are versioned per academic term,
 * inheriting baseline boundaries from school settings and allowing term-specific overrides.
 */

// ---------------------------------------------------------------------------
// Assessment Categories
// ---------------------------------------------------------------------------

export const assessmentCategorySchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    gradebook_id: uuidSchema.openapi({ description: "Owning gradebook." }),
    name: z.string().openapi({
      description: "Category name (e.g. 'Homework', 'Midterm', 'Final Exam').",
      example: "Homework",
    }),
    weight: z.number().openapi({
      description:
        "Percentage weight of this category (0-100). All active weights must sum to 100.",
      example: 20,
    }),
    description: z.string().nullable().openapi({
      description: "Optional human-readable description.",
      example: "Weekly problem sets",
    }),
    sort_order: z.number().int().openapi({
      description: "Display ordering (ascending).",
      example: 0,
    }),
    is_active: z.boolean().openapi({
      description: "Whether this category contributes to the weight total.",
    }),
    created_at: dateTimeSchema.openapi({ description: "Row creation timestamp." }),
    updated_at: dateTimeSchema.openapi({ description: "Last modification timestamp." }),
  })
  .openapi("AssessmentCategory");

export type AssessmentCategory = z.infer<typeof assessmentCategorySchema>;

export const createCategoryBodySchema = z
  .object({
    name: z.string().min(1).max(100).openapi({
      description: "Category name.",
      example: "Homework",
    }),
    weight: z.number().min(0).max(100).openapi({
      description: "Percentage weight (0-100).",
      example: 20,
    }),
    description: z.string().nullable().optional().openapi({
      description: "Optional description.",
    }),
    sort_order: z.number().int().min(0).optional().openapi({
      description: "Display ordering. Defaults to 0.",
    }),
    is_active: z.boolean().optional().openapi({
      description: "Whether this category is active. Defaults to true.",
    }),
  })
  .openapi("CreateAssessmentCategoryBody");

export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;

export const updateCategoryBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional().openapi({
      description: "Updated category name.",
    }),
    weight: z.number().min(0).max(100).optional().openapi({
      description: "Updated percentage weight (0-100).",
    }),
    description: z.string().nullable().optional().openapi({
      description: "Updated description.",
    }),
    sort_order: z.number().int().min(0).optional().openapi({
      description: "Updated display ordering.",
    }),
    is_active: z.boolean().optional().openapi({
      description: "Updated active status.",
    }),
  })
  .openapi("UpdateAssessmentCategoryBody");

export type UpdateCategoryBody = z.infer<typeof updateCategoryBodySchema>;

export const categoryListSchema = z
  .object({
    categories: z.array(assessmentCategorySchema),
    total_weight: z.number().openapi({
      description: "Sum of active category weights (should be 100 for a valid gradebook).",
    }),
  })
  .openapi("AssessmentCategoryList");

export type CategoryList = z.infer<typeof categoryListSchema>;

// ---------------------------------------------------------------------------
// Grade Boundaries
// ---------------------------------------------------------------------------

export const gradeBoundarySchema = z
  .object({
    label: z.string().openapi({
      description: "Grade label (e.g. 'A', 'Pass', '90-100%').",
      example: "A",
    }),
    min: z.number().min(0).max(100).openapi({
      description: "Minimum percentage for this grade (inclusive).",
      example: 90,
    }),
    max: z.number().min(0).max(100).openapi({
      description: "Maximum percentage for this grade (inclusive).",
      example: 100,
    }),
    gpa_points: z.number().nullable().optional().openapi({
      description: "GPA equivalent (null for non-GPA schemes).",
      example: 4.0,
    }),
  })
  .openapi("GradeBoundary");

export type GradeBoundary = z.infer<typeof gradeBoundarySchema>;

// ---------------------------------------------------------------------------
// Grading Schemes
// ---------------------------------------------------------------------------

export const gradingSchemeTypeSchema = z
  .enum(["letter", "percentage", "gpa", "numeric", "pass_fail"])
  .openapi({
    description: "Type of grading scale.",
    example: "letter",
  });

export type GradingSchemeType = z.infer<typeof gradingSchemeTypeSchema>;

export const gradingSchemeSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    term_id: uuidSchema.openapi({ description: "Academic term this scheme belongs to." }),
    version: z.number().int().openapi({
      description: "Immutable version number. Prior versions cannot be modified.",
      example: 1,
    }),
    name: z.string().openapi({
      description: "Human-readable scheme name.",
      example: "Standard Letter Scale",
    }),
    scheme_type: gradingSchemeTypeSchema,
    grade_boundaries: z.array(gradeBoundarySchema).openapi({
      description: "Ordered grade boundaries from highest to lowest.",
    }),
    is_inherited: z.boolean().openapi({
      description: "True if this scheme was auto-generated from school defaults.",
    }),
    created_at: dateTimeSchema.openapi({ description: "Row creation timestamp." }),
  })
  .openapi("GradingScheme");

export type GradingScheme = z.infer<typeof gradingSchemeSchema>;

export const createSchemeBodySchema = z
  .object({
    term_id: uuidSchema.openapi({
      description: "Academic term to create this scheme for.",
    }),
    name: z.string().min(1).max(100).openapi({
      description: "Scheme name.",
      example: "Standard Letter Scale",
    }),
    scheme_type: gradingSchemeTypeSchema,
    grade_boundaries: z.array(gradeBoundarySchema).min(1).openapi({
      description: "Grade boundaries (must have at least one entry).",
    }),
  })
  .openapi("CreateGradingSchemeBody");

export type CreateSchemeBody = z.infer<typeof createSchemeBodySchema>;

export const schemeListSchema = z
  .object({
    schemes: z.array(gradingSchemeSchema),
  })
  .openapi("GradingSchemeList");

export type SchemeList = z.infer<typeof schemeListSchema>;

// ---------------------------------------------------------------------------
// Gradebook Config (combined view)
// ---------------------------------------------------------------------------

export const gradebookConfigSchema = z
  .object({
    gradebook_id: uuidSchema.openapi({ description: "The gradebook this config belongs to." }),
    categories: z.array(assessmentCategorySchema),
    total_weight: z.number().openapi({
      description: "Sum of active category weights.",
    }),
    grading_scheme: gradingSchemeSchema.nullable().openapi({
      description: "The linked grading scheme, or null if none is assigned.",
    }),
  })
  .openapi("GradebookConfig");

export type GradebookConfig = z.infer<typeof gradebookConfigSchema>;

// ---------------------------------------------------------------------------
// Path Params
// ---------------------------------------------------------------------------

export const gradebookIdParamSchema = z
  .object({
    gradebookId: uuidSchema.openapi({
      param: { name: "gradebookId", in: "path" },
      description: "Gradebook UUID.",
    }),
  })
  .openapi("GradebookIdParam");

export const categoryIdParamSchema = z
  .object({
    categoryId: uuidSchema.openapi({
      param: { name: "categoryId", in: "path" },
      description: "Assessment category UUID.",
    }),
  })
  .openapi("CategoryIdParam");

export const schemeIdParamSchema = z
  .object({
    schemeId: uuidSchema.openapi({
      param: { name: "schemeId", in: "path" },
      description: "Grading scheme UUID.",
    }),
  })
  .openapi("SchemeIdParam");

// ---------------------------------------------------------------------------
// Query Params
// ---------------------------------------------------------------------------

export const termIdQuerySchema = z
  .object({
    termId: uuidSchema.openapi({
      param: { name: "termId", in: "query" },
      description: "Filter grading schemes by academic term.",
    }),
  })
  .openapi("TermIdQuery");
