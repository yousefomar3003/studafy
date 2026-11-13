import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

export const publishedGradeParamsSchema = z
  .object({
    studentId: uuidSchema.openapi({
      param: { name: "studentId", in: "path" },
      description: "Student whose published grades are requested.",
    }),
    termId: uuidSchema.openapi({
      param: { name: "termId", in: "path" },
      description: "Academic term to render.",
    }),
  })
  .openapi("PublishedGradeParams");

export const publishedGradeSchema = z
  .object({
    id: uuidSchema,
    grade_submission_id: uuidSchema,
    gradebook_id: uuidSchema,
    class: z.object({
      id: uuidSchema,
      code: z.string(),
    }),
    course: z.object({
      id: uuidSchema,
      code: z.string(),
      name: z.string(),
      credit_hours: z.number().positive(),
    }),
    label: z.string(),
    score: z.number().nullable(),
    max_score: z.number().positive(),
    weight: z.number().positive(),
    percentage: z.number().min(0).max(100).nullable(),
    grade_label: z.string().nullable(),
    gpa_points: z.number().nullable(),
    published_at: dateTimeSchema,
  })
  .openapi("PublishedGrade");

export const publishedTermSummarySchema = z
  .object({
    term_average_percentage: z.number().min(0).max(100).nullable(),
    term_gpa: z.number().nullable(),
    total_credits: z.number().min(0),
    calculated_at: dateTimeSchema.nullable(),
  })
  .openapi("PublishedTermSummary");

export const cumulativeGradeSummarySchema = z
  .object({
    cumulative_gpa: z.number().nullable(),
    total_credits: z.number().min(0),
    through_term_id: uuidSchema,
  })
  .openapi("CumulativeGradeSummary");

export const publishedGradeSnapshotSchema = z
  .object({
    student_id: uuidSchema,
    term_id: uuidSchema,
    grades: z.array(publishedGradeSchema),
    term_summary: publishedTermSummarySchema,
    cumulative_summary: cumulativeGradeSummarySchema,
  })
  .openapi("PublishedGradeSnapshot");

export type PublishedGradeSnapshot = z.infer<typeof publishedGradeSnapshotSchema>;
