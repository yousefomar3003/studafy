import { z } from "@hono/zod-openapi";
import { GRADUATION_LIMITS, GRADUATION_RULE_TYPES } from "@studafy/grading-engine";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

/**
 * Graduation requirements (000258). What each rule type needs is checked by
 * @studafy/grading-engine (validateGraduationRule) in the service, so the schemas here only bound
 * sizes and types.
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

export const graduationSetIdParamSchema = z
  .object({ setId: pathUuid("setId", "Graduation requirement set UUID.") })
  .openapi("GraduationRequirementSetIdParam");

export const graduationStudentParamSchema = z
  .object({ studentId: pathUuid("studentId", "Student UUID.") })
  .openapi("GraduationStudentIdParam");

export const graduationPreviewQuerySchema = z.object({
  student_id: queryUuid("student_id", "The student to check the set against."),
});

export const graduationReportQuerySchema = z.object({
  academic_year_id: queryUuid("academic_year_id", "The academic year the students are placed in."),
  grade_level_id: queryUuid("grade_level_id", "The grade level reported on."),
});

export const graduationRuleTypeSchema = z
  .enum(GRADUATION_RULE_TYPES)
  .openapi("GraduationRuleType", {
    description:
      "total_credits: credits earned >= min_value. group_credits: credits earned in the group's " +
      "subjects >= min_value. subjects_passed: every subject of the group passed. cumulative_gpa / " +
      "cumulative_average: the transcript's cumulative GPA / average percentage >= min_value. " +
      "external_exam: a result recorded for the exam, with a total >= min_value when it is set.",
  });

export const graduationStatusSchema = z
  .enum(["met", "not_met", "pending"])
  .openapi("GraduationStatus", {
    description:
      "met; not_met; or pending: not met yet, but the student's current year is not finalized, so " +
      "results still to come can change it. A cumulative GPA or average stays pending until then.",
  });

const namedSchema = z
  .object({ id: uuidSchema, code: z.string(), name: z.string() })
  .openapi("GraduationNamedRef");

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

// Spread into the rule and its evaluation (not .extend: that becomes an allOf, which the mobile
// client generator does not flatten).
const ruleShape = {
  id: uuidSchema,
  type: graduationRuleTypeSchema,
  min_value: z.number().nullable(),
  group_name: z.string().nullable(),
  subjects: z.array(namedSchema).openapi({ description: "The group's subjects, by name." }),
  external_exam: z
    .object({ id: uuidSchema, code: z.string(), name: z.string() })
    .openapi("GraduationRuleExam")
    .nullable(),
};

export const graduationRuleSchema = z.object(ruleShape).openapi("GraduationRule");

export const graduationSetSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    grade_levels: z
      .array(z.object({ id: uuidSchema, name: z.string() }).openapi("GraduationGradeLevel"))
      .openapi({ description: "The grade levels the set applies to." }),
    // Applies to students in this year or a later one; null: every year.
    applies_from_academic_year: z
      .object({ id: uuidSchema, name: z.string() })
      .openapi("GraduationAcademicYear")
      .nullable(),
    is_active: z.boolean(),
    visible_to_students_and_parents: z.boolean(),
    rules: z.array(graduationRuleSchema),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("GraduationRequirementSet");

export const graduationSetListSchema = z
  .object({ sets: z.array(graduationSetSchema) })
  .openapi("GraduationRequirementSetList");

const ruleInputSchema = z
  .object({
    type: graduationRuleTypeSchema,
    min_value: z.number().nullable().optional(),
    group_name: z.string().trim().max(GRADUATION_LIMITS.groupNameMaxLength).nullable().optional(),
    subject_ids: z.array(uuidSchema).max(GRADUATION_LIMITS.maxSubjectsPerRule).optional(),
    external_exam_id: uuidSchema.nullable().optional(),
  })
  .openapi("GraduationRuleInput");

export const graduationSetBodySchema = z
  .object({
    name: z.string().trim().min(1).max(GRADUATION_LIMITS.setNameMaxLength),
    grade_level_ids: z.array(uuidSchema).min(1).max(100),
    applies_from_academic_year_id: uuidSchema.nullable().optional(),
    is_active: z.boolean().optional().openapi({ description: "Default true." }),
    visible_to_students_and_parents: z
      .boolean()
      .optional()
      .openapi({ description: "Default false." }),
    rules: z
      .array(ruleInputSchema)
      .max(GRADUATION_LIMITS.maxRulesPerSet)
      .openapi({ description: "In display order. Saving replaces the set's rules." }),
  })
  .openapi("GraduationRequirementSetInput");

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

export const graduationRuleEvaluationSchema = z
  .object({
    ...ruleShape,
    status: graduationStatusSchema,
    current: z
      .number()
      .nullable()
      .openapi({
        description:
          "Where the student stands: credits earned, subjects passed, the cumulative GPA or " +
          "average, or the best total recorded for the exam. Null when there is none.",
      }),
    required: z.number().nullable().openapi({
      description: "What the rule asks for; null for an exam that only has to be recorded.",
    }),
    missing_subjects: z.array(namedSchema).openapi({
      description: "subjects_passed: the group's subjects not passed yet.",
    }),
  })
  .openapi("GraduationRuleEvaluation");

const setEvaluationShape = {
  set: z
    .object({ id: uuidSchema, name: z.string(), visible_to_students_and_parents: z.boolean() })
    .openapi("GraduationEvaluatedSet"),
  status: graduationStatusSchema,
  rules_met: z.number().int(),
  rules_total: z.number().int(),
  rules: z.array(graduationRuleEvaluationSchema),
};

export const graduationSetEvaluationSchema = z
  .object(setEvaluationShape)
  .openapi("GraduationSetEvaluation");

export const graduationChecklistSchema = z
  .object({
    student_id: uuidSchema,
    // The grade level of the student's latest placement.
    grade_level: z
      .object({ id: uuidSchema, name: z.string() })
      .openapi("GraduationStudentGradeLevel")
      .nullable(),
    current_year_pending: z.boolean().openapi({
      description: "The student's current year has no finalized annual result yet.",
    }),
    years_counted: z.number().int().openapi({
      description: "Academic years with a finalized annual result counted.",
    }),
    sets: z.array(graduationSetEvaluationSchema).openapi({
      description:
        "Every active set that applies to the student. Students and parents see only the sets " +
        "shown to them.",
    }),
  })
  .openapi("GraduationChecklist");

export const graduationPreviewSchema = z
  .object({
    ...setEvaluationShape,
    student_id: uuidSchema,
    current_year_pending: z.boolean(),
    years_counted: z.number().int(),
    applies: z.boolean().openapi({
      description: "Whether the set applies to the student (active, their grade level and year).",
    }),
  })
  .openapi("GraduationPreview");

export const graduationReportSchema = z
  .object({
    academic_year_id: uuidSchema,
    grade_level_id: uuidSchema,
    students_checked: z.number().int().openapi({
      description: "Students placed in the grade level that year with at least one set applying.",
    }),
    students: z
      .array(
        z
          .object({
            student_id: uuidSchema,
            first_name: z.string(),
            last_name: z.string(),
            admission_number: z.string(),
            section_name: z.string(),
            // not_met when any set is not met, otherwise pending.
            status: graduationStatusSchema,
            sets: z.array(graduationSetEvaluationSchema).openapi({
              description: "The sets not met (yet).",
            }),
          })
          .openapi("GraduationReportStudent", {
            description: "status: not_met when any set is not met, otherwise pending.",
          }),
      )
      .openapi({
        description:
          "Students not on track: a set not met, or not met yet while the year is in progress. " +
          "Not met first, then by name.",
      }),
  })
  .openapi("GraduationReport");

// ---------------------------------------------------------------------------
// Transcript line
// ---------------------------------------------------------------------------

export const transcriptGraduationRequirementSchema = z
  .object({
    name: z.string(),
    status: graduationStatusSchema,
    rules_met: z.number().int(),
    rules_total: z.number().int(),
  })
  .openapi("TranscriptGraduationRequirement");
