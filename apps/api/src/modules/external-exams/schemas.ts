import { z } from "@hono/zod-openapi";
import { EXTERNAL_EXAM_LIMITS, EXTERNAL_EXAM_PRESET_KEYS } from "@studafy/grading-engine";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

/**
 * External exams and test scores (000255). The catalogue's shape follows the database columns;
 * every range, step and label rule is checked by @studafy/grading-engine in the service, so the
 * schemas here only bound sizes and types.
 */

const pathUuid = (name: string, description: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: "path" }, description });

export const externalExamIdParamSchema = z
  .object({ examId: pathUuid("examId", "External exam UUID.") })
  .openapi("ExternalExamIdParam");

export const externalExamResultIdParamSchema = z
  .object({ resultId: pathUuid("resultId", "External exam result UUID.") })
  .openapi("ExternalExamResultIdParam");

export const externalExamStudentParamSchema = z
  .object({ studentId: pathUuid("studentId", "Student UUID.") })
  .openapi("ExternalExamStudentIdParam");

export const externalExamListQuerySchema = z.object({
  include_archived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
    .openapi({ param: { name: "include_archived", in: "query" }, description: "Default false." }),
});

const totalModeSchema = z.enum(["sum", "average", "none"]).openapi("ExternalExamTotalMode", {
  description:
    "sum or average of the numeric components (an average optionally rounded to total_rounding_step), or no total.",
});
const scoreTypeSchema = z.enum(["numeric", "label"]).openapi("ExternalExamScoreType", {
  description: "numeric: a number in min_score..max_score on step. label: one of allowed_labels.",
});

const text = (max: number) => z.string().trim().min(1).max(max);
const score = z
  .number()
  .min(-EXTERNAL_EXAM_LIMITS.maxAbsScore)
  .max(EXTERNAL_EXAM_LIMITS.maxAbsScore);

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const externalExamComponentSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    score_type: scoreTypeSchema,
    min_score: z.number().nullable(),
    max_score: z.number().nullable(),
    step: z.number().nullable(),
    allowed_labels: z.array(z.string()).nullable().openapi({ description: "Best first." }),
    sort_order: z.number().int(),
    has_scores: z.boolean().openapi({
      description: "Results are scored in it: how it is scored is locked and it cannot be removed.",
    }),
  })
  .openapi("ExternalExamComponent");

export const externalExamSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    preset_key: z.string().nullable().openapi({ description: "The preset it was copied from." }),
    total_mode: totalModeSchema,
    total_rounding_step: z.number().nullable(),
    total_min: z.number().nullable(),
    total_max: z.number().nullable(),
    per_subject: z.boolean().openapi({ description: "One result per subject (IGCSE, AP...)." }),
    show_on_transcript: z.boolean(),
    archived_at: dateTimeSchema.nullable(),
    result_count: z.number().int(),
    components: z.array(externalExamComponentSchema),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("ExternalExam");

export const externalExamListSchema = z
  .object({ exams: z.array(externalExamSchema) })
  .openapi("ExternalExamList");

const presetComponentSchema = z
  .object({
    name: z.string(),
    score_type: scoreTypeSchema,
    min_score: z.number().nullable(),
    max_score: z.number().nullable(),
    step: z.number().nullable(),
    allowed_labels: z.array(z.string()).nullable(),
  })
  .openapi("ExternalExamPresetComponent");

export const externalExamPresetKeySchema = z
  .enum(EXTERNAL_EXAM_PRESET_KEYS)
  .openapi("ExternalExamPresetKey");

export const externalExamPresetListSchema = z
  .object({
    presets: z.array(
      z
        .object({
          key: externalExamPresetKeySchema,
          code: z.string(),
          name: z.string(),
          total_mode: totalModeSchema,
          total_rounding_step: z.number().nullable(),
          total_min: z.number().nullable(),
          total_max: z.number().nullable(),
          per_subject: z.boolean(),
          show_on_transcript: z.boolean(),
          note: z.string().nullable().openapi({
            description: "What to check after adding it: defaults that are the school's to set.",
          }),
          components: z.array(presetComponentSchema),
        })
        .openapi("ExternalExamPreset"),
    ),
  })
  .openapi("ExternalExamPresetList");

export const externalExamFromPresetBodySchema = z
  .object({
    preset_key: externalExamPresetKeySchema,
    code: text(EXTERNAL_EXAM_LIMITS.codeLength).optional().openapi({
      description: "Another code, when the preset's is already used in the school.",
    }),
    name: text(EXTERNAL_EXAM_LIMITS.nameLength).optional(),
  })
  .openapi("ExternalExamFromPresetBody");

const componentBodySchema = z
  .object({
    id: uuidSchema.optional().openapi({ description: "An existing component (updates only)." }),
    name: text(EXTERNAL_EXAM_LIMITS.nameLength),
    score_type: scoreTypeSchema,
    min_score: score.nullable().optional(),
    max_score: score.nullable().optional(),
    step: z.number().positive().max(1000).nullable().optional(),
    allowed_labels: z
      .array(text(EXTERNAL_EXAM_LIMITS.labelLength))
      .max(EXTERNAL_EXAM_LIMITS.maxLabels)
      .nullable()
      .optional(),
  })
  .openapi("ExternalExamComponentBody");

export const externalExamBodySchema = z
  .object({
    code: text(EXTERNAL_EXAM_LIMITS.codeLength),
    name: text(EXTERNAL_EXAM_LIMITS.nameLength),
    total_mode: totalModeSchema,
    total_rounding_step: z.number().positive().max(1000).nullable().optional(),
    total_min: score.nullable().optional(),
    total_max: score.nullable().optional(),
    per_subject: z.boolean(),
    show_on_transcript: z.boolean(),
    components: z
      .array(componentBodySchema)
      .min(1)
      .max(EXTERNAL_EXAM_LIMITS.maxComponents)
      .openapi({ description: "In display order." }),
  })
  .openapi("ExternalExamBody");

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const scoreBodySchema = z
  .object({
    component_id: uuidSchema,
    numeric_score: score.nullable().optional(),
    label_score: text(EXTERNAL_EXAM_LIMITS.labelLength).nullable().optional(),
  })
  .openapi("ExternalExamScoreBody", {
    description: "numeric_score for a numeric component, label_score for a label component.",
  });

const resultFields = {
  subject_id: uuidSchema.nullable().optional().openapi({
    description: "Required for a per-subject exam; must be absent or null otherwise.",
  }),
  entry_id: uuidSchema
    .nullable()
    .optional()
    .openapi({
      description:
        "The student's exam entry (entered or withdrawn, same exam, covering the subject) the result " +
        "came from. On update, absent keeps the current link and null clears it.",
    }),
  sat_on: dateSchema,
  note: text(EXTERNAL_EXAM_LIMITS.noteLength).nullable().optional(),
  scores: z.array(scoreBodySchema).min(1).max(EXTERNAL_EXAM_LIMITS.maxComponents),
};

export const recordExternalExamResultBodySchema = z
  .object({ exam_id: uuidSchema, ...resultFields })
  .openapi("RecordExternalExamResultBody");

export const updateExternalExamResultBodySchema = z
  .object(resultFields)
  .openapi("UpdateExternalExamResultBody");

export const externalExamResultSchema = z
  .object({
    id: uuidSchema,
    student_id: uuidSchema,
    exam: z
      .object({
        id: uuidSchema,
        code: z.string(),
        name: z.string(),
        total_mode: totalModeSchema,
        total_min: z.number().nullable(),
        total_max: z.number().nullable(),
        per_subject: z.boolean(),
        archived: z.boolean(),
      })
      .openapi("ExternalExamResultExam"),
    subject: z
      .object({ id: uuidSchema, code: z.string(), name: z.string() })
      .openapi("ExternalExamResultSubject")
      .nullable(),
    entry_id: uuidSchema.nullable().openapi({ description: "The exam entry it came from." }),
    sat_on: dateSchema,
    total_score: z.number().nullable().openapi({
      description:
        "Worked out from the scores when recorded; null when the exam has no total or a component is unscored.",
    }),
    note: z.string().nullable(),
    scores: z.array(
      z
        .object({
          component_id: uuidSchema,
          component_name: z.string(),
          score_type: scoreTypeSchema,
          numeric_score: z.number().nullable(),
          label_score: z.string().nullable(),
          max_score: z.number().nullable(),
        })
        .openapi("ExternalExamScore"),
    ),
    recorded_by_user_id: uuidSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("ExternalExamResult");

export const externalExamResultListSchema = z
  .object({ results: z.array(externalExamResultSchema) })
  .openapi("ExternalExamResultList");

// ---------------------------------------------------------------------------
// Transcript section
// ---------------------------------------------------------------------------

export const transcriptExternalExamSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    total_max: z.number().nullable(),
    results: z.array(
      z
        .object({
          subject: z
            .object({ code: z.string(), name: z.string() })
            .openapi("TranscriptExternalExamSubject")
            .nullable(),
          sat_on: dateSchema,
          total_score: z.number().nullable(),
          scores: z.array(
            z
              .object({
                component: z.string(),
                numeric_score: z.number().nullable(),
                label_score: z.string().nullable(),
                max_score: z.number().nullable(),
              })
              .openapi("TranscriptExternalExamScore"),
          ),
        })
        .openapi("TranscriptExternalExamResult"),
    ),
  })
  .openapi("TranscriptExternalExam");
