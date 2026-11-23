import { z } from "@hono/zod-openapi";
import { CURRICULUM_TEMPLATE_IDS } from "@studafy/grading-engine";
import { uuidSchema } from "@studafy/shared-schemas";

import {
  aggregationSchema,
  categoryKindSchema,
  gradingMethodSchema,
  resultFormatSchema,
} from "./schemas";

import type { CurriculumTemplateId } from "@studafy/grading-engine";

/**
 * Curriculum templates (packages/grading-engine/src/templates.ts): the list, and the preview and
 * apply of one template to an academic year's grades. Kept apart from schemas.ts so the contract
 * reads on its own.
 */

const templateIdSchema = z
  .enum(CURRICULUM_TEMPLATE_IDS as [CurriculumTemplateId, ...CurriculumTemplateId[]])
  .openapi("CurriculumTemplateId");

// Language of the names a template shows and writes (scale, bands, categories). Referenced plainly,
// without per-field descriptions or defaults: either makes the generated Dart client wrap the enum
// in a class it can't compile. Defaults are applied in the handlers instead.
const templateLocaleSchema = z.enum(["en", "ar"]).openapi("CurriculumTemplateLocale");

export const curriculumTemplateQuerySchema = z.object({
  // Language of the template names and descriptions; English when absent.
  locale: templateLocaleSchema.optional(),
});

export const curriculumTemplateSchema = z
  .object({
    id: templateIdSchema,
    family: z.enum(["national", "british", "ib", "american", "french", "irish"]),
    name: z.string(),
    description: z.string(),
    grading_method: gradingMethodSchema,
    result_format: resultFormatSchema,
    result_scale_max: z.number().nullable(),
    max_marks: z.number(),
    pass_percentage: z.number(),
    scale: z
      .object({
        name: z.string(),
        bands: z.array(
          z
            .object({
              label: z.string(),
              min_percentage: z.number(),
              gpa_points: z.number().nullable(),
            })
            .openapi("CurriculumTemplateBand"),
        ),
      })
      .nullable()
      .openapi({ description: "The grade's scale; null for descriptor templates." }),
    descriptors: z
      .array(
        z
          .object({ label: z.string(), points: z.number().nullable(), not_achieved: z.boolean() })
          .openapi("CurriculumTemplateDescriptor"),
      )
      .nullable()
      .openapi({ description: "The grade's descriptor scale, highest first; descriptive only." }),
    categories_source: z.enum(["exam_structure", "template"]).openapi({
      description:
        "exam_structure: subjects follow the school's exam system (School Settings); template: the categories listed here, one assessment of each per term.",
    }),
    categories: z.array(
      z
        .object({
          name: z.string(),
          kind: categoryKindSchema,
          weight: z.number().nullable(),
          aggregation: aggregationSchema,
          max_marks: z.number(),
        })
        .openapi("CurriculumTemplateCategory"),
    ),
    subject_credits: z
      .object({ credits: z.number(), average_weight: z.number() })
      .nullable()
      .openapi({
        description: "Credits and coefficient every subject gets; null keeps each subject's own.",
      }),
    course_levels: z.array(
      z
        .object({ label: z.string(), gpa_boost: z.number() })
        .openapi("CurriculumTemplateCourseLevel"),
    ),
  })
  .openapi("CurriculumTemplate");

export const curriculumTemplateListSchema = z
  .object({ templates: z.array(curriculumTemplateSchema) })
  .openapi("CurriculumTemplateList");

const requestFields = {
  template_id: templateIdSchema,
  grade_level_ids: z.array(uuidSchema).min(1).max(100),
  // Language of the names the template writes; the school's language when absent.
  locale: templateLocaleSchema.optional(),
};

export const curriculumTemplatePreviewBodySchema = z
  .object(requestFields)
  .openapi("CurriculumTemplatePreviewBody");

export const curriculumTemplateApplyBodySchema = z
  .object({
    ...requestFields,
    confirm: z.boolean().default(false).openapi({
      description:
        "Required (true) when the preview says requires_confirmation: existing configuration changes.",
    }),
  })
  .openapi("CurriculumTemplateApplyBody");

export const curriculumTemplatePlanSchema = z
  .object({
    template_id: templateIdSchema,
    template_name: z.string(),
    academic_year_id: uuidSchema,
    academic_year_name: z.string(),
    locale: templateLocaleSchema,
    applied: z.boolean(),
    requires_confirmation: z.boolean(),
    scale: z
      .object({
        action: z.enum(["create", "update", "unchanged"]),
        scale_id: uuidSchema.nullable(),
        name: z.string(),
      })
      .nullable()
      .openapi("CurriculumTemplateScalePlan"),
    grades: z.array(
      z
        .object({
          grade_level_id: uuidSchema,
          grade_level_name: z.string(),
          program: z
            .object({
              action: z.enum(["create", "update", "unchanged"]),
              changes: z.array(z.enum(["grade_scale", "result_format", "rounding"])),
            })
            .openapi("CurriculumTemplateProgramPlan"),
          descriptors: z.enum(["create", "replace", "unchanged"]).nullable(),
          error: z.string().nullable().openapi({
            description: "Set by an apply when the grade itself could not be set up.",
          }),
          subjects: z.array(
            z
              .object({
                config_id: uuidSchema,
                subject_id: uuidSchema,
                subject_name: z.string(),
                action: z.enum(["update", "unchanged", "skip"]),
                reason: z
                  .enum(["has_marks", "section_assessments", "no_terms", "invalid"])
                  .nullable(),
                detail: z.string().nullable(),
              })
              .openapi("CurriculumTemplateSubjectPlan"),
          ),
        })
        .openapi("CurriculumTemplateGradePlan"),
    ),
  })
  .openapi("CurriculumTemplatePlan");
