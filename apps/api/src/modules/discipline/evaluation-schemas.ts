import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

export const evaluationTypeSchema = z
  .enum([
    "formal_observation",
    "peer_review",
    "self_assessment",
    "student_feedback",
    "annual_review",
    "probationary_review",
  ])
  .openapi({ description: "Type of teacher evaluation." });

export type EvaluationType = z.infer<typeof evaluationTypeSchema>;

export const evaluationRatingSchema = z
  .enum(["unsatisfactory", "developing", "proficient", "exemplary"])
  .openapi({ description: "Overall evaluation rating." });

export type EvaluationRating = z.infer<typeof evaluationRatingSchema>;

export const evaluationStatusSchema = z
  .enum(["draft", "submitted", "finalized"])
  .openapi({ description: "Lifecycle state of the evaluation." });

export type EvaluationStatus = z.infer<typeof evaluationStatusSchema>;

export const evaluationSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    teacher_id: uuidSchema.openapi({ description: "Teacher being evaluated." }),
    evaluator_user_id: uuidSchema.openapi({
      description: "Principal who authored the evaluation.",
    }),
    class_id: uuidSchema.nullable().openapi({ description: "Associated class, if any." }),
    evaluation_type: evaluationTypeSchema,
    rating: evaluationRatingSchema.nullable().openapi({ description: "Overall rating." }),
    strengths: z.string().nullable().openapi({ description: "Identified strengths." }),
    areas_for_improvement: z.string().nullable().openapi({ description: "Growth areas." }),
    comments: z.string().nullable().openapi({ description: "General comments." }),
    narrative: z.string().nullable().openapi({ description: "Free-text evaluation narrative." }),
    status: evaluationStatusSchema,
    shared_with_teacher: z.boolean().openapi({ description: "Whether the teacher can view this." }),
    shared_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ description: "When shared with teacher." }),
    evaluated_at: z.string().datetime().openapi({ description: "When the evaluation took place." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("TeacherEvaluation");

export type Evaluation = z.infer<typeof evaluationSchema>;

export const evaluationCriteriaTemplateSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    title: z.string().openapi({ description: "Criteria title." }),
    description: z.string().nullable().openapi({ description: "Detailed description." }),
    max_score: z.number().openapi({ description: "Maximum score for this criterion." }),
    sort_order: z.number().int().openapi({ description: "Display order." }),
    is_active: z.boolean().openapi({ description: "Soft-delete flag." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("EvaluationCriteriaTemplate");

export type EvaluationCriteriaTemplate = z.infer<typeof evaluationCriteriaTemplateSchema>;

export const evaluationScoreSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    evaluation_id: uuidSchema.openapi({ description: "Parent evaluation." }),
    criteria_template_id: uuidSchema.openapi({ description: "Criteria being scored." }),
    score: z.number().openapi({ description: "Awarded score." }),
    comment: z.string().nullable().openapi({ description: "Score justification." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("EvaluationScore");

export type EvaluationScore = z.infer<typeof evaluationScoreSchema>;

export const evaluationWithScoresSchema = evaluationSchema
  .extend({
    scores: z.array(evaluationScoreSchema).openapi({ description: "Criteria scores." }),
  })
  .openapi("EvaluationWithScores");

export type EvaluationWithScores = z.infer<typeof evaluationWithScoresSchema>;

export const createEvaluationBodySchema = z
  .object({
    teacher_id: uuidSchema.openapi({ description: "Teacher being evaluated." }),
    evaluation_type: evaluationTypeSchema,
    class_id: uuidSchema.optional().openapi({ description: "Associated class, if any." }),
    rating: evaluationRatingSchema.optional().openapi({ description: "Overall rating." }),
    strengths: z.string().optional().openapi({ description: "Identified strengths." }),
    areas_for_improvement: z.string().optional().openapi({ description: "Growth areas." }),
    comments: z.string().optional().openapi({ description: "General comments." }),
    narrative: z.string().optional().openapi({ description: "Free-text evaluation narrative." }),
    evaluated_at: z.string().datetime().openapi({ description: "When the evaluation took place." }),
  })
  .openapi("CreateEvaluationBody");

export type CreateEvaluationBody = z.infer<typeof createEvaluationBodySchema>;

export const updateEvaluationBodySchema = z
  .object({
    rating: evaluationRatingSchema.optional(),
    strengths: z.string().optional(),
    areas_for_improvement: z.string().optional(),
    comments: z.string().optional(),
    narrative: z.string().optional(),
    class_id: uuidSchema.nullable().optional(),
  })
  .openapi("UpdateEvaluationBody");

export type UpdateEvaluationBody = z.infer<typeof updateEvaluationBodySchema>;

export const createCriteriaTemplateBodySchema = z
  .object({
    title: z.string().min(1).openapi({ description: "Criteria title." }),
    description: z.string().optional().openapi({ description: "Detailed description." }),
    max_score: z.number().positive().openapi({ description: "Maximum score." }),
    sort_order: z.number().int().min(0).default(0).openapi({ description: "Display order." }),
  })
  .openapi("CreateCriteriaTemplateBody");

export type CreateCriteriaTemplateBody = z.infer<typeof createCriteriaTemplateBodySchema>;

export const updateCriteriaTemplateBodySchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    max_score: z.number().positive().optional(),
    sort_order: z.number().int().min(0).optional(),
    is_active: z.boolean().optional(),
  })
  .openapi("UpdateCriteriaTemplateBody");

export type UpdateCriteriaTemplateBody = z.infer<typeof updateCriteriaTemplateBodySchema>;

export const upsertScoreBodySchema = z
  .object({
    score: z
      .number()
      .min(0)
      .openapi({ description: "Awarded score (validated against template max_score in service)." }),
    comment: z.string().optional().openapi({ description: "Score justification." }),
  })
  .openapi("UpsertScoreBody");

export type UpsertScoreBody = z.infer<typeof upsertScoreBodySchema>;

export const evaluationListSchema = z
  .object({
    evaluations: z.array(evaluationWithScoresSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("EvaluationList");

export const evaluationTemplateListSchema = z
  .object({
    templates: z.array(evaluationCriteriaTemplateSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("EvaluationTemplateList");

export const evaluationScoreListSchema = z
  .object({
    scores: z.array(evaluationScoreSchema),
  })
  .openapi("EvaluationScoreList");

export const evaluationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    teacher_id: uuidSchema.optional().openapi({ description: "Filter by teacher." }),
    evaluation_type: evaluationTypeSchema.optional().openapi({ description: "Filter by type." }),
    status: evaluationStatusSchema.optional().openapi({ description: "Filter by status." }),
  })
  .openapi("EvaluationQuery");

export const evaluationTemplateQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    is_active: z.coerce.boolean().optional().openapi({ description: "Filter by active status." }),
  })
  .openapi("EvaluationTemplateQuery");

export const evaluationIdParamSchema = z
  .object({
    evaluationId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "evaluationId", in: "path" },
        description: "Teacher evaluation UUID.",
      }),
  })
  .openapi("EvaluationIdParam");

export const templateIdParamSchema = z
  .object({
    templateId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "templateId", in: "path" },
        description: "Criteria template UUID.",
      }),
  })
  .openapi("TemplateIdParam");

export const scoreParamSchema = z
  .object({
    evaluationId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "evaluationId", in: "path" },
        description: "Teacher evaluation UUID.",
      }),
    criteriaTemplateId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "criteriaTemplateId", in: "path" },
        description: "Criteria template UUID.",
      }),
  })
  .openapi("ScoreParam");
