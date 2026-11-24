import { z } from "@hono/zod-openapi";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { OUTCOME_CODE_MAX, OUTCOME_STRAND_MAX, OUTCOME_TEXT_MAX } from "./outcome-service";
import {
  LESSON_LONG_TEXT_MAX,
  LESSON_TEXT_MAX,
  LESSON_TITLE_MAX,
  PLAN_MATERIALS_MAX,
  PLAN_OUTCOMES_MAX,
  REVIEW_COMMENT_MAX,
  TERM_PLAN_NOTES_MAX,
  TERM_PLAN_WEEKS_MAX,
  WEEK_NOTES_MAX,
  WEEK_UNIT_MAX,
} from "./plan-service";
import { ACHIEVEMENT_LEVELS_MAX, ACHIEVEMENT_LEVELS_MIN } from "./settings-service";

/**
 * Learning outcomes, outcome achievement, and lesson and term plans (000267). Shared enums are
 * referenced plainly and objects are spelled out (no .extend / allOf), so the mobile client
 * generator produces plain classes.
 */

const pathUuid = (name: string, description: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: "path" }, description });

const queryUuid = (name: string, description: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: "query" }, description });

export const outcomeIdParamSchema = z
  .object({ outcomeId: pathUuid("outcomeId", "Learning outcome UUID.") })
  .openapi("LearningOutcomeIdParam");

export const planIdParamSchema = z
  .object({ planId: pathUuid("planId", "Plan UUID.") })
  .openapi("AcademicPlanIdParam");

export const sectionSubjectParamSchema = z
  .object({
    sectionId: pathUuid("sectionId", "Grade section UUID."),
    subjectId: pathUuid("subjectId", "Subject UUID."),
  })
  .openapi("AcademicPlanSectionSubjectParam");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const achievementLevelSchema = z
  .object({
    level: z.number().int().openapi({ description: "1 = the lowest." }),
    label: z.string(),
    label_ar: z.string().nullable(),
  })
  .openapi("OutcomeAchievementLevel");

export const planningSettingsSchema = z
  .object({
    show_outcomes_on_report_cards: z.boolean().openapi({
      description:
        "Copy outcome achievement into finalized results, report cards and the student and parent results views.",
    }),
    lesson_plan_lead_days: z.number().int().openapi({
      description:
        "A lesson plan is on time when first submitted at least this many days before the lesson.",
    }),
    term_plan_due_days: z.number().int().openapi({
      description:
        "A term plan is on time when first submitted by the term's first day plus this many days.",
    }),
    achievement_levels: z.array(achievementLevelSchema),
    achievement_levels_default: z.boolean().openapi({
      description: "True while the school uses the default four levels.",
    }),
  })
  .openapi("PlanningSettings");

export const planningSettingsBodySchema = z
  .object({
    show_outcomes_on_report_cards: z.boolean().optional(),
    lesson_plan_lead_days: z.number().int().min(0).max(30).optional(),
    term_plan_due_days: z.number().int().min(-90).max(90).optional(),
    achievement_levels: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(60),
            label_ar: z.string().trim().max(60).nullable().optional(),
          })
          .openapi("OutcomeAchievementLevelInput"),
      )
      .min(ACHIEVEMENT_LEVELS_MIN)
      .max(ACHIEVEMENT_LEVELS_MAX)
      .optional()
      .openapi({ description: "The whole scale, lowest first; numbered 1..n in this order." }),
  })
  .openapi("PlanningSettingsBody");

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const learningOutcomeSchema = z
  .object({
    id: uuidSchema,
    subject_id: uuidSchema,
    subject_code: z.string(),
    subject_name: z.string(),
    grade_level_id: uuidSchema,
    grade_level_name: z.string(),
    code: z.string(),
    text: z.string(),
    text_ar: z.string().nullable(),
    strand: z.string().nullable(),
    sort_order: z.number().int(),
    archived: z.boolean(),
    in_use: z.boolean().openapi({
      description: "Used by achievement or a plan: it can be archived, not deleted.",
    }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("LearningOutcome");

export const learningOutcomeListSchema = z
  .object({ outcomes: z.array(learningOutcomeSchema) })
  .openapi("LearningOutcomeList");

export const learningOutcomeListQuerySchema = z.object({
  subject_id: queryUuid("subject_id", "Only this subject's outcomes.").optional(),
  grade_level_id: queryUuid("grade_level_id", "Only this grade level's outcomes.").optional(),
  include_archived: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      param: { name: "include_archived", in: "query" },
      description: "Include archived outcomes.",
    }),
});

const outcomeText = {
  code: z.string().trim().min(1).max(OUTCOME_CODE_MAX),
  text: z.string().trim().min(1).max(OUTCOME_TEXT_MAX),
  text_ar: z.string().trim().max(OUTCOME_TEXT_MAX).nullable().optional(),
  strand: z.string().trim().max(OUTCOME_STRAND_MAX).nullable().optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
};

export const learningOutcomeBodySchema = z
  .object({ subject_id: uuidSchema, grade_level_id: uuidSchema, ...outcomeText })
  .openapi("LearningOutcomeBody");

export const learningOutcomeUpdateBodySchema = z
  .object({
    code: outcomeText.code.optional(),
    text: outcomeText.text.optional(),
    text_ar: outcomeText.text_ar,
    strand: outcomeText.strand,
    sort_order: outcomeText.sort_order,
    archived: z.boolean().optional(),
  })
  .openapi("LearningOutcomeUpdateBody");

export const learningOutcomeImportBodySchema = z
  .object({
    csv: z.string().min(1).max(1_000_000).openapi({
      description:
        "CSV with a header row: subject (code), grade (grade level name), code, text; optional text_ar, strand, sort_order. Comma, semicolon or tab separated.",
    }),
    dry_run: z.boolean().optional().openapi({ description: "Check only; nothing is written." }),
  })
  .openapi("LearningOutcomeImportBody");

export const learningOutcomeImportResultSchema = z
  .object({
    applied: z.boolean().openapi({
      description: "False on a dry run or when any row has an error: nothing was written.",
    }),
    created: z.number().int(),
    updated: z.number().int(),
    unchanged: z.number().int(),
    errors: z.array(
      z
        .object({ line: z.number().int(), message: z.string() })
        .openapi("LearningOutcomeImportError"),
    ),
  })
  .openapi("LearningOutcomeImportResult");

// ---------------------------------------------------------------------------
// Achievement
// ---------------------------------------------------------------------------

export const termQuerySchema = z.object({
  term_id: queryUuid("term_id", "The term; omit for the whole year.").optional(),
});

const sectionSubjectAccessSchema = z
  .enum(["leadership", "teacher", "coordinator"])
  .openapi("SectionSubjectAccess");

const planOutcomeSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    text: z.string(),
    text_ar: z.string().nullable(),
    strand: z.string().nullable(),
  })
  .openapi("PlanOutcome");

export const sectionOutcomeAchievementsSchema = z
  .object({
    section_id: uuidSchema,
    section_name: z.string(),
    grade_level_id: uuidSchema,
    grade_level_name: z.string(),
    academic_year_id: uuidSchema,
    subject_id: uuidSchema,
    subject_name: z.string(),
    term_id: uuidSchema.nullable(),
    access: sectionSubjectAccessSchema,
    editable: z.boolean().openapi({
      description: "A teacher may save: the year is active and the period not finalized.",
    }),
    finalized: z.boolean(),
    show_on_report_cards: z.boolean(),
    levels: z.array(achievementLevelSchema),
    terms: z.array(
      z.object({ term_id: uuidSchema, term_name: z.string() }).openapi("OutcomeAchievementTerm"),
    ),
    outcomes: z.array(
      z
        .object({
          id: uuidSchema,
          code: z.string(),
          text: z.string(),
          text_ar: z.string().nullable(),
          strand: z.string().nullable(),
          archived: z.boolean(),
        })
        .openapi("OutcomeAchievementOutcome"),
    ),
    students: z.array(
      z
        .object({
          student_id: uuidSchema,
          first_name: z.string(),
          last_name: z.string(),
          admission_number: z.string(),
          achievements: z.array(
            z
              .object({ outcome_id: uuidSchema, level: z.number().int() })
              .openapi("OutcomeAchievementValue"),
          ),
        })
        .openapi("OutcomeAchievementStudent"),
    ),
  })
  .openapi("SectionOutcomeAchievements");

export const outcomeAchievementsBodySchema = z
  .object({
    term_id: uuidSchema.nullable().openapi({ description: "The term; null for the whole year." }),
    achievements: z
      .array(
        z
          .object({
            student_id: uuidSchema,
            outcome_id: uuidSchema,
            level: z.number().int().min(1).max(10).nullable().openapi({
              description: "A level of the school's scale; null removes it.",
            }),
          })
          .openapi("OutcomeAchievementInput"),
      )
      .max(5000),
  })
  .openapi("OutcomeAchievementsBody");

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const planStatusSchema = z
  .enum(["draft", "submitted", "approved", "returned"])
  .openapi("AcademicPlanStatus", {
    description:
      "draft, submitted (awaiting review), approved, or returned with a comment for changes.",
  });

const headerShape = {
  id: uuidSchema,
  academic_year_id: uuidSchema,
  term_id: uuidSchema.nullable(),
  term_name: z.string().nullable(),
  section_id: uuidSchema,
  section_name: z.string(),
  grade_level_id: uuidSchema,
  grade_level_name: z.string(),
  subject_id: uuidSchema,
  subject_name: z.string(),
  author_user_id: uuidSchema,
  author_name: z.string().nullable(),
  status: planStatusSchema,
  first_submitted_at: dateTimeSchema.nullable(),
  submitted_at: dateTimeSchema.nullable(),
  reviewed_at: dateTimeSchema.nullable(),
  reviewed_by_user_id: uuidSchema.nullable(),
  reviewed_by_name: z.string().nullable(),
  review_comment: z.string().nullable(),
  due_on: dateSchema.nullable().openapi({ description: "The day the plan is due." }),
  on_time: z.boolean().nullable().openapi({
    description: "Whether the first submission came by the due day; null until submitted.",
  }),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
};

const permissionShape = {
  can_edit: z.boolean(),
  can_submit: z.boolean(),
  can_delete: z.boolean(),
  can_review: z.boolean(),
};

export const termPlanSummarySchema = z
  .object({ ...headerShape, week_count: z.number().int(), outcome_count: z.number().int() })
  .openapi("TermPlanSummary");

export const termPlanListSchema = z
  .object({ section_id: uuidSchema, subject_id: uuidSchema, plans: z.array(termPlanSummarySchema) })
  .openapi("TermPlanList");

export const termPlanSchema = z
  .object({
    ...headerShape,
    ...permissionShape,
    notes: z.string().nullable(),
    weeks: z.array(
      z
        .object({
          week_number: z.number().int(),
          starts_on: dateSchema.nullable(),
          unit: z.string().nullable(),
          notes: z.string().nullable(),
          outcomes: z.array(planOutcomeSchema),
        })
        .openapi("TermPlanWeek"),
    ),
  })
  .openapi("TermPlan");

const weekInputSchema = z
  .object({
    week_number: z.number().int().min(1).max(TERM_PLAN_WEEKS_MAX),
    starts_on: dateSchema.nullable().optional(),
    unit: z.string().max(WEEK_UNIT_MAX).nullable().optional(),
    notes: z.string().max(WEEK_NOTES_MAX).nullable().optional(),
    outcome_ids: z.array(uuidSchema).max(PLAN_OUTCOMES_MAX),
  })
  .openapi("TermPlanWeekInput");

export const termPlanUpdateBodySchema = z
  .object({
    notes: z.string().max(TERM_PLAN_NOTES_MAX).nullable().optional(),
    weeks: z.array(weekInputSchema).max(TERM_PLAN_WEEKS_MAX),
  })
  .openapi("TermPlanUpdateBody");

export const termPlanBodySchema = z
  .object({
    term_id: uuidSchema,
    notes: z.string().max(TERM_PLAN_NOTES_MAX).nullable().optional(),
    weeks: z.array(weekInputSchema).max(TERM_PLAN_WEEKS_MAX),
  })
  .openapi("TermPlanBody");

export const lessonPlanSummarySchema = z
  .object({
    ...headerShape,
    lesson_date: dateSchema,
    period: z.number().int().nullable(),
    title: z.string(),
    outcome_count: z.number().int(),
  })
  .openapi("LessonPlanSummary");

export const lessonPlanListSchema = z
  .object({
    section_id: uuidSchema,
    subject_id: uuidSchema,
    plans: z.array(lessonPlanSummarySchema),
  })
  .openapi("LessonPlanList");

export const lessonPlanListQuerySchema = z.object({
  from: dateSchema
    .optional()
    .openapi({ param: { name: "from", in: "query" }, description: "Lessons on or after." }),
  to: dateSchema
    .optional()
    .openapi({ param: { name: "to", in: "query" }, description: "Lessons on or before." }),
});

const materialRefSchema = z
  .object({ id: uuidSchema, title: z.string() })
  .openapi("LessonPlanMaterial");

export const lessonPlanSchema = z
  .object({
    ...headerShape,
    ...permissionShape,
    lesson_date: dateSchema,
    period: z.number().int().nullable(),
    title: z.string(),
    objectives: z.string().nullable(),
    activities: z.string().nullable(),
    resources: z.string().nullable(),
    homework: z.string().nullable(),
    reflection: z.string().nullable(),
    can_reflect: z.boolean().openapi({
      description: "A teacher of the class may write the reflection, in any status.",
    }),
    outcomes: z.array(planOutcomeSchema),
    materials: z.array(materialRefSchema).openapi({
      description: "Linked class materials, with the title as linked.",
    }),
  })
  .openapi("LessonPlan");

export const lessonPlanBodySchema = z
  .object({
    lesson_date: dateSchema,
    period: z.number().int().min(1).max(20).nullable().optional(),
    title: z.string().trim().min(1).max(LESSON_TITLE_MAX),
    objectives: z.string().max(LESSON_LONG_TEXT_MAX).nullable().optional(),
    activities: z.string().max(LESSON_LONG_TEXT_MAX).nullable().optional(),
    resources: z.string().max(LESSON_TEXT_MAX).nullable().optional(),
    homework: z.string().max(LESSON_TEXT_MAX).nullable().optional(),
    outcome_ids: z.array(uuidSchema).max(PLAN_OUTCOMES_MAX),
    material_ids: z.array(uuidSchema).max(PLAN_MATERIALS_MAX),
  })
  .openapi("LessonPlanBody");

export const lessonReflectionBodySchema = z
  .object({ reflection: z.string().max(LESSON_TEXT_MAX).nullable() })
  .openapi("LessonReflectionBody");

export const lessonPlanOptionsQuerySchema = z.object({
  date: dateSchema.optional().openapi({
    param: { name: "date", in: "query" },
    description: "The lesson date, for its periods.",
  }),
});

export const lessonPlanOptionsSchema = z
  .object({
    lesson_date: dateSchema.nullable(),
    periods: z.array(z.number().int()).openapi({
      description: "The live timetable's periods for this section's subject on that date.",
    }),
    materials: z.array(materialRefSchema),
    outcomes: z.array(planOutcomeSchema),
  })
  .openapi("LessonPlanOptions");

export const planReviewBodySchema = z
  .object({
    decision: z.enum(["approve", "return"]).openapi("AcademicPlanReviewDecision"),
    comment: z.string().max(REVIEW_COMMENT_MAX).nullable().optional().openapi({
      description: "Required when returning the plan.",
    }),
  })
  .openapi("AcademicPlanReviewBody");

export const planReviewsQuerySchema = z.object({
  academic_year_id: queryUuid(
    "academic_year_id",
    "The academic year; omit for the latest active or finalized year.",
  ).optional(),
  status: z
    .enum(["draft", "submitted", "approved", "returned"])
    .optional()
    .openapi({ param: { name: "status", in: "query" }, description: "Default: submitted." }),
});

export const planReviewsSchema = z
  .object({
    academic_year_id: uuidSchema.nullable(),
    status: planStatusSchema,
    term_plans: z.array(
      z
        .object({
          ...headerShape,
          week_count: z.number().int(),
          outcome_count: z.number().int(),
          can_review: z.boolean(),
        })
        .openapi("TermPlanReviewItem"),
    ),
    lesson_plans: z.array(
      z
        .object({
          ...headerShape,
          lesson_date: dateSchema,
          period: z.number().int().nullable(),
          title: z.string(),
          outcome_count: z.number().int(),
          can_review: z.boolean(),
        })
        .openapi("LessonPlanReviewItem"),
    ),
  })
  .openapi("AcademicPlanReviews");

export const planCoverageQuerySchema = z.object({
  term_id: queryUuid("term_id", "The term reported on."),
});

export const planCoverageSchema = z
  .object({
    academic_year_id: uuidSchema,
    term_id: uuidSchema,
    term_name: z.string(),
    rows: z.array(
      z
        .object({
          section_id: uuidSchema,
          section_name: z.string(),
          grade_level_name: z.string(),
          subject_id: uuidSchema,
          subject_name: z.string(),
          teacher_names: z.array(z.string()),
          term_plan: z
            .object({
              id: uuidSchema,
              status: planStatusSchema,
              submitted_at: dateTimeSchema.nullable(),
              on_time: z.boolean().nullable(),
            })
            .openapi("PlanCoverageTermPlan")
            .nullable(),
          term_plan_due_on: dateSchema,
          lesson_plans: z
            .object({
              total: z.number().int(),
              draft: z.number().int(),
              submitted: z.number().int(),
              approved: z.number().int(),
              returned: z.number().int(),
              on_time: z.number().int(),
              late: z.number().int(),
              overdue: z.number().int().openapi({
                description: "Still a draft past its due day.",
              }),
            })
            .openapi("PlanCoverageLessons"),
          outcomes: z
            .object({ total: z.number().int(), covered: z.number().int() })
            .openapi("PlanCoverageOutcomes", {
              description:
                "The grade's active outcomes for the subject, and how many the term's submitted plans name.",
            }),
        })
        .openapi("PlanCoverageRow"),
    ),
  })
  .openapi("PlanCoverage");
