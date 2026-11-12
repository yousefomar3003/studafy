import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { resultDisplaySchema } from "./schemas";

/**
 * Academic transcripts (000207): every year of a student's finalized annual results on one
 * document, with cumulative figures. Kept apart from schemas.ts so the transcript contract reads
 * on its own; it reuses the certificate's subject and overall shapes field for field.
 */

export const transcriptIdParamSchema = z
  .object({
    transcriptId: z
      .string()
      .uuid()
      .openapi({ param: { name: "transcriptId", in: "path" }, description: "Transcript UUID." }),
  })
  .openapi("TranscriptIdParam");

const transcriptSubjectSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    requirement: z.string(),
    marks_obtained: z.number().nullable(),
    max_marks: z.number(),
    percentage: z.number().nullable(),
    grade_label: z.string().nullable(),
    gpa_points: z.number().nullable(),
    passed: z.boolean().nullable(),
    exempt: z.boolean(),
    include_in_average: z.boolean(),
    average_weight: z.number(),
  })
  .openapi("TranscriptSubject");

const transcriptYearSchema = z
  .object({
    academic_year: z
      .object({ id: uuidSchema, code: z.string(), name: z.string() })
      .openapi("TranscriptAcademicYear"),
    grade_level_name: z.string(),
    section_name: z.string(),
    finalization: z
      .object({ id: uuidSchema, version: z.number().int(), finalized_at: dateTimeSchema })
      .openapi("TranscriptFinalization"),
    subjects: z.array(transcriptSubjectSchema),
    overall: z
      .object({
        average_percentage: z.number().nullable(),
        total_obtained: z.number().nullable(),
        total_max: z.number().nullable(),
        grade_label: z.string().nullable(),
        subjects_failed: z.number().int(),
        academic_status: z.string(),
        display: resultDisplaySchema.nullable(),
      })
      .openapi("TranscriptYearOverall"),
  })
  .openapi("TranscriptYear");

const transcriptCumulativeShape = z.object({
  average_percentage: z.number().nullable().openapi({
    description:
      "Weighted mean percentage over every counted subject of every year (each subject weighted by its average weight).",
  }),
  gpa: z.number().nullable().openapi({
    description:
      "Weighted mean of the subjects' GPA points; null when any counted subject has none.",
  }),
  gpa_unavailable_reason: z.enum(["no_subjects", "incomplete", "missing_gpa_points"]).nullable(),
  subjects_without_gpa_points: z.array(z.string()),
  years_covered: z.number().int(),
  subjects_counted: z.number().int(),
});

export const transcriptCumulativeSchema = transcriptCumulativeShape.openapi("TranscriptCumulative");

export const transcriptContentSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("transcript"),
    serial_number: z.string(),
    issued_at: dateTimeSchema,
    school: z.object({ id: uuidSchema, name: z.string() }).openapi("TranscriptSchool"),
    student: z
      .object({
        id: uuidSchema,
        first_name: z.string(),
        last_name: z.string(),
        admission_number: z.string(),
      })
      .openapi("TranscriptStudent"),
    years: z.array(transcriptYearSchema).openapi({ description: "Oldest year first." }),
    cumulative: transcriptCumulativeSchema,
    issued_by: z
      .object({ user_id: uuidSchema, name: z.string().nullable() })
      .openapi("TranscriptIssuedBy"),
    reissue: z
      .object({ supersedes_serial: z.string(), reason: z.string() })
      .openapi("TranscriptReissue")
      .nullable(),
  })
  .openapi("TranscriptContent");

export const transcriptStaleReasonSchema = z.enum(["corrected", "new_results"]).openapi({
  description:
    "corrected: a covered year's results were corrected since. new_results: a newer year has been finalized since.",
});

export const transcriptSchema = z
  .object({
    id: uuidSchema,
    serial_number: z.string(),
    status: z.enum(["issued", "superseded", "revoked"]),
    student_id: uuidSchema,
    issued_at: dateTimeSchema,
    supersedes_id: uuidSchema.nullable(),
    reissue_reason: z.string().nullable(),
    revoked_at: dateTimeSchema.nullable(),
    revoke_reason: z.string().nullable(),
    content_sha256: z.string(),
    needs_reissue: z.boolean(),
    stale_reasons: z.array(transcriptStaleReasonSchema),
    content: transcriptContentSchema,
  })
  .openapi("AcademicTranscript");

export const transcriptListSchema = z
  .object({ transcripts: z.array(transcriptSchema) })
  .openapi("AcademicTranscriptList");

export const transcriptReadinessSchema = z
  .object({
    state: z.enum(["ready", "issued", "needs_reissue", "blocked"]),
    reasons: z.array(z.string()),
    current_transcript_id: uuidSchema.nullable(),
    years: z.array(
      z
        .object({
          academic_year_id: uuidSchema,
          academic_year_name: z.string(),
          grade_level_name: z.string(),
          section_name: z.string(),
          status: z.enum(["complete", "incomplete"]),
        })
        .openapi("TranscriptReadinessYear"),
    ),
    // Its own component: a nullable reuse of TranscriptCumulative would make that one nullable too.
    cumulative: transcriptCumulativeShape.openapi("TranscriptReadinessCumulative").nullable(),
  })
  .openapi("TranscriptReadiness");
