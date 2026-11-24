import { z } from "@hono/zod-openapi";
import { DIPLOMA_LIMITS } from "@studafy/grading-engine";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

/**
 * IB Diploma total (000263): the grade's diploma rules, the diploma outcome on results and
 * documents, and core grade entry. Flat objects only (every field present, unused ones null), so
 * the generated web and mobile clients read them as plain classes.
 */

export const coreGradeSchema = z.enum(["A", "B", "C", "D", "E"]).openapi("DiplomaCoreGrade", {
  description: "A Theory of Knowledge or Extended Essay grade, A (best) to E.",
});

export const diplomaConditionSchema = z
  .object({
    type: z.enum([
      "min_total",
      "cas_complete",
      "core_grade_not",
      "max_subjects_at_or_below",
      "min_level_points",
    ]),
    value: z.number().min(0).max(DIPLOMA_LIMITS.maxConditionValue).nullable().openapi({
      description:
        "min_total: the minimum total. max_subjects_at_or_below: the most subjects allowed. min_level_points: the minimum points.",
    }),
    points: z.number().min(0).max(DIPLOMA_LIMITS.maxConditionValue).nullable().openapi({
      description:
        "max_subjects_at_or_below: subjects with this many points or fewer are counted (1 for 'no grade 1').",
    }),
    grade: z.enum(["A", "B", "C", "D", "E"]).nullable().openapi({
      description: "core_grade_not: the grade neither TOK nor the Extended Essay may have.",
    }),
    level: z.string().trim().max(DIPLOMA_LIMITS.maxLevelLength).nullable().openapi({
      description: "min_level_points: the course level (HL, SL), compared without case.",
    }),
    best_of: z.number().int().min(1).max(DIPLOMA_LIMITS.maxCountedSubjects).nullable().openapi({
      description: "min_level_points: only the best N subjects at the level count; null for all.",
    }),
  })
  .openapi("DiplomaCondition", {
    description:
      "One award condition. A level condition applies only when a counted subject has that course level.",
  });

export const diplomaMatrixCellSchema = z
  .object({
    tok: coreGradeSchema,
    ee: coreGradeSchema,
    points: z.number().int().min(0).max(DIPLOMA_LIMITS.maxCorePoints),
  })
  .openapi("DiplomaMatrixCell");

export const diplomaConfigSchema = z
  .object({
    counted_subjects: z.number().int().min(1).max(DIPLOMA_LIMITS.maxCountedSubjects).openapi({
      description: "How many subjects' points count (the best ones); 6 for the IB Diploma.",
    }),
    core_matrix: z.array(diplomaMatrixCellSchema).max(25).openapi({
      description: "Core points for every TOK x Extended Essay grade pair (all 25).",
    }),
    conditions: z.array(diplomaConditionSchema).max(DIPLOMA_LIMITS.maxConditions),
  })
  .openapi("DiplomaConfig", {
    description:
      "A points_total grade's IB Diploma rules. The defaults are the published IB matrix and the main failing conditions, stored as editable data: the school must check them against the IB rules in force.",
  });

export const diplomaFailingConditionSchema = z
  .object({
    code: z.enum([
      "TOO_FEW_SUBJECTS",
      "MIN_TOTAL",
      "CAS_INCOMPLETE",
      "CORE_GRADE",
      "SUBJECTS_AT_OR_BELOW",
      "LEVEL_POINTS",
    ]),
    required: z.number().nullable().openapi({
      description: "What the rule asks for (minimum total or points, most subjects, subjects).",
    }),
    actual: z.number().nullable().openapi({ description: "What the student has." }),
    component: z.enum(["tok", "ee"]).nullable().openapi({ description: "CORE_GRADE only." }),
    grade: z.enum(["A", "B", "C", "D", "E"]).nullable().openapi({
      description: "CORE_GRADE: the failing grade.",
    }),
    level: z.string().nullable().openapi({ description: "LEVEL_POINTS: the course level." }),
    points: z.number().nullable().openapi({
      description: "SUBJECTS_AT_OR_BELOW: the subject points counted.",
    }),
  })
  .openapi("DiplomaFailingCondition");

export const diplomaResultSchema = z
  .object({
    status: z.enum(["awarded", "not_awarded", "pending"]).openapi({
      description:
        "not_awarded when any award condition fails; pending while subject points, TOK/EE grades or CAS are missing; awarded otherwise.",
    }),
    total: z.number().nullable().openapi({
      description: "Subject points + core points; null while either is unknown.",
    }),
    max: z.number(),
    subject_points: z.number().nullable(),
    core_points: z.number().nullable(),
    counted_subject_ids: z.array(uuidSchema).openapi({
      description: "The subjects whose points count, best first.",
    }),
    tok_grade: z.enum(["A", "B", "C", "D", "E"]).nullable(),
    ee_grade: z.enum(["A", "B", "C", "D", "E"]).nullable(),
    cas_complete: z.boolean().nullable(),
    failing_conditions: z.array(diplomaFailingConditionSchema),
    pending_reasons: z.array(
      z.enum(["subjects_incomplete", "core_grades_missing", "cas_not_recorded"]),
    ),
  })
  .openapi("DiplomaResult", {
    description:
      "The IB Diploma outcome of a points_total result: total out of max (45), core points, the TOK/EE/CAS used and the award status with its failing conditions.",
  });

// ---------------------------------------------------------------------------
// Core grade entry
// ---------------------------------------------------------------------------

export const diplomaCoreKindSchema = z.enum(["final", "predicted"]).openapi("DiplomaCoreKind", {
  description:
    "final: the grades the diploma total is finalized with. predicted: the forecast that, with predicted subject grades, gives the predicted total.",
});

const coreValuesShape = {
  tok_grade: z.enum(["A", "B", "C", "D", "E"]).nullable(),
  ee_grade: z.enum(["A", "B", "C", "D", "E"]).nullable(),
  cas_complete: z.boolean().nullable(),
};

export const diplomaCoreValuesSchema = z
  .object({ ...coreValuesShape, updated_at: dateTimeSchema })
  .openapi("DiplomaCoreValues");

export const sectionDiplomaCoreSchema = z
  .object({
    section_id: uuidSchema,
    section_name: z.string(),
    grade_level_name: z.string(),
    academic_year_id: uuidSchema,
    enabled: z.boolean().openapi({
      description: "Whether the grade's result is the IB Diploma total (points_total) this year.",
    }),
    predicted_enabled: z.boolean().openapi({
      description: "Whether the grade records predicted grades (and so predicted core grades).",
    }),
    editable: z.boolean().openapi({
      description: "Enabled, and the year's grading is neither finalized nor archived.",
    }),
    students: z.array(
      z
        .object({
          student_id: uuidSchema,
          first_name: z.string(),
          last_name: z.string(),
          admission_number: z.string(),
          final: diplomaCoreValuesSchema.nullable(),
          predicted: diplomaCoreValuesSchema.nullable(),
        })
        .openapi("SectionDiplomaCoreStudent"),
    ),
  })
  .openapi("SectionDiplomaCore");

export const saveDiplomaCoreBodySchema = z
  .object({
    kind: diplomaCoreKindSchema,
    grades: z
      .array(
        z.object({ student_id: uuidSchema, ...coreValuesShape }).openapi("SaveDiplomaCoreItem", {
          description: "All three null removes the student's row of this kind.",
        }),
      )
      .min(1)
      .max(500),
  })
  .openapi("SaveDiplomaCoreBody");

export const studentDiplomaSchema = z
  .object({
    student_id: uuidSchema,
    years: z.array(
      z
        .object({
          academic_year_id: uuidSchema,
          academic_year_name: z.string(),
          section_id: uuidSchema,
          section_name: z.string(),
          grade_level_name: z.string(),
          can_edit: z.boolean().openapi({
            description: "School leadership may change this year's core grades.",
          }),
          final: diplomaCoreValuesSchema.nullable().openapi({
            description:
              "The final TOK/EE/CAS grades; staff only (students and parents see them on finalized results).",
          }),
          predicted: diplomaCoreValuesSchema.nullable(),
          predicted_result: diplomaResultSchema.nullable().openapi({
            description:
              "The predicted total from the year's predicted subject grades (the year's prediction, else the latest term's) and the predicted core grades. Null when predicted grades are off, or hidden from the student and parents.",
          }),
        })
        .openapi("StudentDiplomaYear"),
    ),
  })
  .openapi("StudentDiploma");
