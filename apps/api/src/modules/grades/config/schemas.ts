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

export const classIdQuerySchema = z
  .object({
    classId: uuidSchema.openapi({
      param: { name: "classId", in: "query" },
      description: "The class whose gradebook to resolve.",
    }),
  })
  .openapi("ClassIdQuery");

// ---------------------------------------------------------------------------
// Gradebook (the class-scoped container the entry grid hangs off)
// ---------------------------------------------------------------------------

export const gradebookSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    class_id: uuidSchema.openapi({ description: "The class this gradebook belongs to." }),
    status: z
      .enum(["draft", "active", "archived"])
      .openapi({ description: "Lifecycle status of the gradebook." }),
    grading_scheme_id: uuidSchema.nullable().openapi({
      description: "The linked grading scheme version, or null if none is assigned yet.",
    }),
    created_at: dateTimeSchema.openapi({ description: "Row creation timestamp." }),
    updated_at: dateTimeSchema.openapi({ description: "Last modification timestamp." }),
  })
  .openapi("Gradebook");

export type Gradebook = z.infer<typeof gradebookSchema>;

// ---------------------------------------------------------------------------
// Grade entry — grade submissions and grade records (ST-113)
// ---------------------------------------------------------------------------

export const gradeSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    grade_submission_id: uuidSchema.openapi({ description: "Owning grade submission." }),
    score: z.number().nullable().openapi({
      description: "Numeric score. Null means ungraded.",
      example: 85,
    }),
    max_score: z.number().openapi({
      description: "Maximum possible score (must be > 0).",
      example: 100,
    }),
    weight: z.number().openapi({
      description: "Relative weight of this item within the submission (default 1).",
      example: 1,
    }),
    label: z.string().openapi({
      description: "Human-readable identifier (e.g. 'Midterm', 'Homework 3').",
      example: "Midterm Exam",
    }),
    created_at: dateTimeSchema.openapi({ description: "Row creation timestamp." }),
    updated_at: dateTimeSchema.openapi({ description: "Last modification timestamp." }),
  })
  .openapi("Grade");

export type Grade = z.infer<typeof gradeSchema>;

export const gradeSubmissionSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    gradebook_id: uuidSchema.openapi({ description: "Owning gradebook." }),
    student_id: uuidSchema.openapi({ description: "The student this submission belongs to." }),
    status: z
      .enum(["draft", "submitted", "approved", "rejected", "published"])
      .openapi({ description: "Lifecycle status." }),
    submitted_by_user_id: uuidSchema.nullable().openapi({
      description: "Who submitted it (set by trigger on draft→submitted).",
    }),
    decided_by_user_id: uuidSchema.nullable().openapi({
      description: "Who approved/rejected it (set by trigger on approval transitions).",
    }),
    rejection_reason: z.string().nullable().openapi({
      description: "Reason for rejection. Set only when status is 'rejected'.",
      example: "Scores are not yet final.",
    }),
    submitted_at: dateTimeSchema.nullable().openapi({
      description: "When it was submitted (set by trigger).",
    }),
    decided_at: dateTimeSchema.nullable().openapi({
      description: "When it was decided (set by trigger).",
    }),
    created_at: dateTimeSchema.openapi({ description: "Row creation timestamp." }),
    updated_at: dateTimeSchema.openapi({ description: "Last modification timestamp." }),
    grades: z.array(gradeSchema).openapi({ description: "Individual grade records." }),
  })
  .openapi("GradeSubmission");

export type GradeSubmission = z.infer<typeof gradeSubmissionSchema>;

// ---------------------------------------------------------------------------
// Path & Query Params
// ---------------------------------------------------------------------------

export const submissionIdParamSchema = z
  .object({
    submissionId: uuidSchema.openapi({
      param: { name: "submissionId", in: "path" },
      description: "Grade submission UUID.",
    }),
  })
  .openapi("SubmissionIdParam");

export const gradebookEntryQuerySchema = z
  .object({
    status: z
      .enum(["draft", "submitted", "approved", "rejected", "published"])
      .optional()
      .openapi({
        param: { name: "status", in: "query" },
        description: "Filter submissions by status.",
      }),
  })
  .openapi("GradebookEntryQuery");

// ---------------------------------------------------------------------------
// Request Bodies
// ---------------------------------------------------------------------------

export const createAssessmentBodySchema = z
  .object({
    label: z.string().min(1).max(100).openapi({
      description: "Human-readable identifier for the assessment (e.g. 'Midterm', 'Homework 3').",
      example: "Midterm Exam",
    }),
    max_score: z.number().gt(0).openapi({
      description: "Maximum possible score for this assessment (must be > 0).",
      example: 100,
    }),
    weight: z.number().gt(0).optional().openapi({
      description: "Relative weight of this assessment within the submission. Defaults to 1.",
      example: 1,
    }),
  })
  .openapi("CreateAssessmentBody");

export type CreateAssessmentBody = z.infer<typeof createAssessmentBodySchema>;

export const updateGradeEntrySchema = z
  .object({
    id: uuidSchema.openapi({ description: "Grade record UUID." }),
    score: z.number().nullable().openapi({
      description: "New score (null to ungrade). Must be 0 ≤ score ≤ max_score.",
      example: 85,
    }),
    updated_at: z.string().openapi({
      description:
        "Concurrency token from the client's last read of this grade. " +
        "If it does not match the current row, the update is rejected with 409.",
      example: "2026-07-29T10:00:00.000Z",
    }),
  })
  .openapi("UpdateGradeEntry");

export type UpdateGradeEntry = z.infer<typeof updateGradeEntrySchema>;

export const bulkUpdateGradesBodySchema = z
  .object({
    grades: z.array(updateGradeEntrySchema).min(1).max(100).openapi({
      description: "Up to 100 grade cells to update atomically.",
    }),
  })
  .openapi("BulkUpdateGradesBody");

export type BulkUpdateGradesBody = z.infer<typeof bulkUpdateGradesBodySchema>;

export const submissionStatusUpdateBodySchema = z
  .object({
    status: z
      .enum(["draft", "submitted", "approved", "rejected", "published"])
      .openapi({ description: "Target status. Valid transitions enforced by DB trigger." }),
    updated_at: z.string().openapi({
      description:
        "Concurrency token from the client's last read of the submission. " +
        "If it does not match the current row, the update is rejected with 409.",
    }),
  })
  .openapi("SubmissionStatusUpdateBody");

export type SubmissionStatusUpdateBody = z.infer<typeof submissionStatusUpdateBodySchema>;

// ---------------------------------------------------------------------------
// Grade submission workflow bodies (ST-114)
// ---------------------------------------------------------------------------

export const submitBodySchema = z
  .object({
    updated_at: z.string().openapi({
      description:
        "Concurrency token from the client's last read of the submission. " +
        "If it does not match the current row, the update is rejected with 409.",
      example: "2026-07-29T10:00:00.000Z",
    }),
  })
  .openapi("SubmitGradeBody");

export type SubmitBody = z.infer<typeof submitBodySchema>;

export const decideActionSchema = z.enum(["approve", "reject"]).openapi({
  description: "Administrative decision on a submitted grade.",
  example: "approve",
});

export const decideBodySchema = z
  .object({
    action: decideActionSchema,
    rejection_reason: z.string().min(1).nullable().optional().openapi({
      description:
        "Reason for rejection. Required when action is 'reject', ignored when 'approve'.",
      example: "Scores are not yet final; please review the midterm adjustment.",
    }),
    updated_at: z.string().openapi({
      description:
        "Concurrency token from the client's last read of the submission. " +
        "If it does not match the current row, the update is rejected with 409.",
      example: "2026-07-29T10:00:00.000Z",
    }),
  })
  .openapi("DecideGradeBody");

export type DecideBody = z.infer<typeof decideBodySchema>;

export const unlockBodySchema = z
  .object({
    updated_at: z.string().openapi({
      description:
        "Concurrency token from the client's last read of the submission. " +
        "If it does not match the current row, the update is rejected with 409.",
      example: "2026-07-29T10:00:00.000Z",
    }),
  })
  .openapi("UnlockGradeBody");

export type UnlockBody = z.infer<typeof unlockBodySchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export const gradebookEntryListSchema = z
  .object({
    submissions: z.array(gradeSubmissionSchema).openapi({
      description: "All submissions for this gradebook matching the optional status filter.",
    }),
  })
  .openapi("GradebookEntryList");

export type GradebookEntryList = z.infer<typeof gradebookEntryListSchema>;
