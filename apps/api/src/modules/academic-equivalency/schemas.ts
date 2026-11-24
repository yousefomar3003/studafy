import { z } from "@hono/zod-openapi";
import {
  EQUIVALENCY_CONVERSION_MODES,
  EQUIVALENCY_GPA_BASES,
  EQUIVALENCY_LIMITS,
  EQUIVALENCY_PART_TYPES,
  EQUIVALENCY_SOURCE_SYSTEMS,
  MULTI_YEAR_LIMITS,
} from "@studafy/grading-engine";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

/**
 * Tawjihi equivalency and multi-year results (000266). What each part or configuration needs is
 * checked by @studafy/grading-engine (validateEquivalencyParts, validateMultiYearYears) in the
 * services, so the schemas here only bound sizes and types. Shared enums are referenced plainly
 * (no per-field description, no default): the mobile client generator cannot compile the wrappers
 * those produce.
 */

const ESTIMATE_NOTICE =
  "An estimate under the school's own editable rules, which the school confirms: not an official " +
  "Ministry of Education conversion.";

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

export const equivalencySetIdParamSchema = z
  .object({ setId: pathUuid("setId", "Equivalency rule set UUID.") })
  .openapi("EquivalencyRuleSetIdParam");

export const multiYearConfigIdParamSchema = z
  .object({ configId: pathUuid("configId", "Multi-year result configuration UUID.") })
  .openapi("MultiYearResultConfigIdParam");

export const academicEquivalencyStudentParamSchema = z
  .object({ studentId: pathUuid("studentId", "Student UUID.") })
  .openapi("AcademicEquivalencyStudentIdParam");

export const equivalencyStudentsQuerySchema = z.object({
  academic_year_id: queryUuid("academic_year_id", "The academic year the students are placed in."),
  grade_level_id: queryUuid("grade_level_id", "The grade level listed."),
});

const namedSchema = z
  .object({ id: uuidSchema, code: z.string(), name: z.string() })
  .openapi("EquivalencyNamedRef");

const gradeLevelRefSchema = z
  .object({ id: uuidSchema, name: z.string() })
  .openapi("EquivalencyGradeLevel");

// ---------------------------------------------------------------------------
// Equivalency rule sets
// ---------------------------------------------------------------------------

export const equivalencySourceSystemSchema = z
  .enum(EQUIVALENCY_SOURCE_SYSTEMS)
  .openapi("EquivalencySourceSystem", {
    description:
      "The qualification a rule set is for: igcse_a_level, ib, american or other. A label for " +
      "lists and examples; any part type can be used in any set.",
  });

export const equivalencyPartTypeSchema = z
  .enum(EQUIVALENCY_PART_TYPES)
  .openapi("EquivalencyPartType", {
    description:
      "exam_subjects: per-subject external exam grades (IGCSE, A Level...) through a grade -> " +
      "percentage table, the best N subjects. diploma_total: the IB Diploma total of the latest " +
      "finalized annual result. gpa: the cumulative (or weighted) GPA. exam_total: the best total " +
      "of one external exam (SAT). The last three convert through a table or a formula.",
  });

export const equivalencyConversionModeSchema = z
  .enum(EQUIVALENCY_CONVERSION_MODES)
  .openapi("EquivalencyConversionMode", {
    description:
      "table: the highest band whose minimum the value reaches gives its percentage (below every " +
      "band: no estimate). linear: intercept + slope x value, clamped to 0-100.",
  });

export const equivalencyGpaBasisSchema = z
  .enum(EQUIVALENCY_GPA_BASES)
  .openapi("EquivalencyGpaBasis", {
    description:
      "gpa: the cumulative GPA. weighted_gpa: the weighted GPA (the GPA when nothing is boosted).",
  });

const gradePercentageSchema = z
  .object({
    grade: z.string().trim().min(1).max(EQUIVALENCY_LIMITS.gradeMaxLength),
    percentage: z.number(),
  })
  .openapi("EquivalencyGradePercentage");

const bandSchema = z.object({ min: z.number(), percentage: z.number() }).openapi("EquivalencyBand");

const conversionSchema = z
  .object({
    mode: equivalencyConversionModeSchema,
    bands: z.array(bandSchema).max(EQUIVALENCY_LIMITS.maxBands).openapi({
      description: "table: the rows, any order. Empty for linear.",
    }),
    slope: z.number().nullable(),
    intercept: z.number().nullable(),
  })
  .openapi("EquivalencyConversion");

export const equivalencyPartSchema = z
  .object({
    type: equivalencyPartTypeSchema,
    label: z.string().trim().min(1).max(EQUIVALENCY_LIMITS.partLabelMaxLength),
    weight: z.number().openapi({ description: "Relative weight in the estimate (0 < w <= 100)." }),
    required: z.boolean().openapi({
      description:
        "Missing data in a required part leaves the estimate incomplete; an optional part is " +
        "left out and the others share its weight.",
    }),
    exam_ids: z.array(uuidSchema).max(EQUIVALENCY_LIMITS.maxExamsPerPart).openapi({
      description: "exam_subjects: the catalogue exams counted. exam_total: exactly one.",
    }),
    best_count: z.number().int().nullable().openapi({
      description: "exam_subjects: how many subjects count, best first; null: all.",
    }),
    min_count: z.number().int().nullable().openapi({
      description: "exam_subjects: the fewest counted subjects for an estimate; null: best_count.",
    }),
    required_subject_ids: z.array(uuidSchema).max(EQUIVALENCY_LIMITS.maxSubjectsCounted).openapi({
      description: "exam_subjects: subjects that always count.",
    }),
    grade_percentages: z.array(gradePercentageSchema).max(EQUIVALENCY_LIMITS.maxGrades).openapi({
      description: "exam_subjects: the percentage each grade label converts to.",
    }),
    conversion: conversionSchema.nullable(),
    require_awarded: z.boolean().openapi({
      description: "diploma_total: no estimate unless the diploma was awarded.",
    }),
    gpa_basis: equivalencyGpaBasisSchema.nullable(),
  })
  .openapi("EquivalencyPart");

export const equivalencyRuleSetSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    source_system: equivalencySourceSystemSchema,
    grade_levels: z.array(gradeLevelRefSchema).openapi({
      description: "The grade levels the set applies to.",
    }),
    is_active: z.boolean(),
    visible_to_students_and_parents: z.boolean(),
    parts: z.array(equivalencyPartSchema),
    exams: z.array(namedSchema).openapi({ description: "The exams the parts name." }),
    subjects: z.array(namedSchema).openapi({ description: "The subjects the parts require." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("EquivalencyRuleSet");

export const equivalencyRuleSetListSchema = z
  .object({ sets: z.array(equivalencyRuleSetSchema) })
  .openapi("EquivalencyRuleSetList");

export const equivalencyRuleSetBodySchema = z
  .object({
    name: z.string().trim().min(1).max(EQUIVALENCY_LIMITS.setNameMaxLength),
    source_system: equivalencySourceSystemSchema,
    grade_level_ids: z.array(uuidSchema).min(1).max(100),
    is_active: z.boolean().optional().openapi({ description: "Default true." }),
    visible_to_students_and_parents: z
      .boolean()
      .optional()
      .openapi({ description: "Default false." }),
    parts: z
      .array(equivalencyPartSchema)
      .min(1)
      .max(EQUIVALENCY_LIMITS.maxParts)
      .openapi({ description: "In display order. Saving replaces the set's parts." }),
  })
  .openapi("EquivalencyRuleSetInput");

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

export const equivalencyStatusSchema = z
  .enum(["estimated", "incomplete", "not_eligible"])
  .openapi("EquivalencyStatus", {
    description:
      "estimated: every required part worked out. incomplete: data still missing (results, a " +
      "diploma, a GPA). not_eligible: a rule gives no estimate (diploma not awarded, a value below " +
      "the conversion table).",
  });

export const equivalencyPartStatusSchema = z
  .enum(["counted", "missing", "skipped", "not_eligible"])
  .openapi("EquivalencyPartStatus", {
    description:
      "counted; missing (data still to come); skipped (an optional part without data); " +
      "not_eligible (a rule gives no percentage).",
  });

export const equivalencyIssueCodeSchema = z
  .enum([
    "NO_EXAM_RESULTS",
    "TOO_FEW_SUBJECTS",
    "REQUIRED_SUBJECT_MISSING",
    "UNMAPPED_GRADE",
    "NO_DIPLOMA_RESULT",
    "DIPLOMA_PENDING",
    "DIPLOMA_NOT_AWARDED",
    "NO_GPA",
    "NO_EXAM_TOTAL",
    "BELOW_CONVERSION_TABLE",
    "CURRENT_YEAR_PENDING",
    "OPTIONAL_PART_SKIPPED",
    "NO_PARTS",
  ])
  .openapi("EquivalencyIssueCode");

export const equivalencyIssueKindSchema = z
  .enum(["missing", "not_eligible", "note"])
  .openapi("EquivalencyIssueKind", {
    description:
      "missing: data still to come; not_eligible: a rule gives no estimate; note: does not block it.",
  });

// Its own schema, only ever nullable: a nullable reference to a schema also used non-null becomes
// an allOf, which the mobile client generator cannot compile.
const issueRefSchema = z
  .object({ id: uuidSchema, code: z.string(), name: z.string() })
  .openapi("EquivalencyIssueRef")
  .nullable();

const issueSchema = z
  .object({
    code: equivalencyIssueCodeSchema,
    kind: equivalencyIssueKindSchema,
    part_index: z.number().int().nullable(),
    subject: issueRefSchema,
    exam: issueRefSchema,
    grade: z.string().nullable(),
    required: z.number().nullable(),
    actual: z.number().nullable(),
  })
  .openapi("EquivalencyIssue", {
    description:
      "Why the estimate is missing, not eligible or worth a note, with the part (0-based), " +
      "subject, exam, grade and the figures involved where they apply.",
  });

const subjectStepSchema = z
  .object({
    subject: namedSchema,
    exam: namedSchema,
    grade: z.string(),
    percentage: z.number().nullable().openapi({
      description: "Null when the grade has no percentage in the part's table.",
    }),
    counted: z.boolean(),
    required_subject: z.boolean(),
  })
  .openapi("EquivalencySubjectStep");

const partResultSchema = z
  .object({
    index: z.number().int(),
    type: equivalencyPartTypeSchema,
    label: z.string(),
    weight: z.number(),
    required: z.boolean(),
    status: equivalencyPartStatusSchema,
    percentage: z.number().nullable(),
    share: z.number().nullable().openapi({
      description: "The part's share of the estimate in percent, once skipped parts are left out.",
    }),
    source_value: z.number().nullable().openapi({
      description: "The value converted: the diploma total, the GPA or the exam total.",
    }),
    source_max: z.number().nullable(),
    subjects: z.array(subjectStepSchema).openapi({
      description: "exam_subjects: every result considered, best first.",
    }),
  })
  .openapi("EquivalencyPartResult");

const estimateShape = {
  status: equivalencyStatusSchema,
  percentage: z
    .number()
    .nullable()
    .openapi({
      description: `The estimated Tawjihi-equivalent percentage; null unless estimated. ${ESTIMATE_NOTICE}`,
    }),
  parts: z.array(partResultSchema),
  issues: z.array(issueSchema),
};

export const equivalencyEstimateSchema = z
  .object({
    set: z
      .object({
        id: uuidSchema,
        name: z.string(),
        source_system: equivalencySourceSystemSchema,
        visible_to_students_and_parents: z.boolean(),
      })
      .openapi("EquivalencyEstimatedSet"),
    ...estimateShape,
  })
  .openapi("EquivalencyEstimate", { description: ESTIMATE_NOTICE });

export const studentEquivalencySchema = z
  .object({
    student_id: uuidSchema,
    // The grade level of the student's latest placement.
    grade_level: z
      .object({ id: uuidSchema, name: z.string() })
      .openapi("EquivalencyStudentGradeLevel")
      .nullable(),
    current_year_pending: z.boolean().openapi({
      description: "The student's current year has no finalized annual result yet.",
    }),
    estimates: z.array(equivalencyEstimateSchema).openapi({
      description:
        "Every active rule set for the student's grade level. Students and parents see only the " +
        "sets shown to them.",
    }),
  })
  .openapi("StudentEquivalency");

export const equivalencyStudentListSchema = z
  .object({
    set_id: uuidSchema,
    academic_year_id: uuidSchema,
    grade_level_id: uuidSchema,
    applies_to_grade_level: z.boolean().openapi({
      description: "Whether the set lists the grade level (every student is estimated anyway).",
    }),
    students: z.array(
      z
        .object({
          student_id: uuidSchema,
          first_name: z.string(),
          last_name: z.string(),
          admission_number: z.string(),
          section_name: z.string(),
          ...estimateShape,
        })
        .openapi("EquivalencyStudentRow"),
    ),
  })
  .openapi("EquivalencyStudentList", { description: ESTIMATE_NOTICE });

// ---------------------------------------------------------------------------
// Multi-year results
// ---------------------------------------------------------------------------

export const multiYearStatusSchema = z
  .enum(["complete", "pending", "incomplete"])
  .openapi("MultiYearStatus", {
    description:
      "complete: every year finalized. pending: a year is not finalized yet. incomplete: a year " +
      "has no finalized result here, or an incomplete one.",
  });

export const multiYearYearStatusSchema = z
  .enum(["finalized", "incomplete", "pending", "missing"])
  .openapi("MultiYearYearStatus", {
    description:
      "finalized; incomplete (finalized, result incomplete); pending (the student is in that " +
      "grade now or has not reached it); missing (went through it without a finalized result here).",
  });

const multiYearConfigYearSchema = z
  .object({ grade_level: gradeLevelRefSchema, weight: z.number() })
  .openapi("MultiYearResultConfigYear");

export const multiYearConfigSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    is_active: z.boolean(),
    visible_to_students_and_parents: z.boolean(),
    years: z.array(multiYearConfigYearSchema).openapi({
      description: "The grade levels and their relative weights, in order.",
    }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("MultiYearResultConfig");

export const multiYearConfigListSchema = z
  .object({ configs: z.array(multiYearConfigSchema) })
  .openapi("MultiYearResultConfigList");

export const multiYearConfigBodySchema = z
  .object({
    name: z.string().trim().min(1).max(MULTI_YEAR_LIMITS.nameMaxLength),
    is_active: z.boolean().optional().openapi({ description: "Default true." }),
    visible_to_students_and_parents: z
      .boolean()
      .optional()
      .openapi({ description: "Default false." }),
    years: z
      .array(
        z
          .object({ grade_level_id: uuidSchema, weight: z.number() })
          .openapi("MultiYearResultConfigYearInput"),
      )
      .min(MULTI_YEAR_LIMITS.minYears)
      .max(MULTI_YEAR_LIMITS.maxYears)
      .openapi({ description: "In display order; weights are relative (40 and 60)." }),
  })
  .openapi("MultiYearResultConfigInput");

const multiYearStudentYearSchema = z
  .object({
    grade_level: gradeLevelRefSchema,
    weight: z.number(),
    share: z.number().openapi({ description: "The year's share in percent." }),
    status: multiYearYearStatusSchema,
    academic_year: z
      .object({ id: uuidSchema, name: z.string() })
      .openapi("MultiYearAcademicYear")
      .nullable(),
    overall_percentage: z.number().nullable(),
  })
  .openapi("MultiYearStudentYear");

const multiYearSubjectSchema = z
  .object({
    subject_id: uuidSchema,
    code: z.string(),
    name: z.string(),
    percentage: z.number().nullable().openapi({
      description: "Weighted over the years the subject has a figure; null until complete.",
    }),
    years_counted: z.number().int(),
    by_year: z
      .array(
        z
          .object({ grade_level_id: uuidSchema, percentage: z.number().nullable() })
          .openapi("MultiYearSubjectYear"),
      )
      .openapi({ description: "Each configured year's figure, in order." }),
  })
  .openapi("MultiYearSubjectResult");

export const multiYearStudentResultSchema = z
  .object({
    config: z
      .object({ id: uuidSchema, name: z.string(), visible_to_students_and_parents: z.boolean() })
      .openapi("MultiYearEvaluatedConfig"),
    status: multiYearStatusSchema,
    overall_percentage: z.number().nullable().openapi({
      description: "The weighted overall percentage; null until every year is finalized.",
    }),
    years: z.array(multiYearStudentYearSchema),
    subjects: z.array(multiYearSubjectSchema),
  })
  .openapi("MultiYearStudentResult");

export const studentMultiYearResultsSchema = z
  .object({
    student_id: uuidSchema,
    results: z.array(multiYearStudentResultSchema).openapi({
      description:
        "Every active configuration listing the student's grade level. Students and parents see " +
        "only the ones shown to them.",
    }),
  })
  .openapi("StudentMultiYearResults");
