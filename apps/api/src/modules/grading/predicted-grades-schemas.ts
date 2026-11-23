import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { PREDICTED_LABEL_MAX, PREDICTED_NOTE_MAX } from "./predicted-grades-service";
import { predictedGradesVisibilitySchema } from "./schemas";

/** Predicted grades (000254). */

export const predictedGradesQuerySchema = z
  .object({
    term_id: uuidSchema.optional().openapi({
      description: "The term; omit for the predictions for the whole year.",
    }),
  })
  .openapi("PredictedGradesQuery");

export const sectionPredictedGradesSchema = z
  .object({
    section_id: uuidSchema,
    section_name: z.string(),
    grade_level_name: z.string(),
    academic_year_id: uuidSchema,
    subject_id: uuidSchema,
    subject_name: z.string(),
    term_id: uuidSchema.nullable(),
    enabled: z.boolean().openapi({
      description: "Whether the grade's program records predicted grades this year.",
    }),
    visibility: predictedGradesVisibilitySchema,
    editable: z.boolean().openapi({
      description: "Enabled, and the year's grading is neither finalized nor archived.",
    }),
    labels: z.array(z.string()).openapi({
      description:
        "The bands of the subject's grade scale, highest first. Empty when the subject has no scale (any label up to 40 characters).",
    }),
    students: z.array(
      z
        .object({
          student_id: uuidSchema,
          first_name: z.string(),
          last_name: z.string(),
          admission_number: z.string(),
          grade_label: z.string().nullable(),
          note: z.string().nullable(),
          updated_at: dateTimeSchema.nullable(),
        })
        .openapi("SectionPredictedGradeStudent"),
    ),
  })
  .openapi("SectionPredictedGrades");

export const savePredictedGradesBodySchema = z
  .object({
    term_id: uuidSchema.nullable().openapi({ description: "The term, or null for the year." }),
    grades: z
      .array(
        z
          .object({
            student_id: uuidSchema,
            grade_label: z.string().max(PREDICTED_LABEL_MAX).nullable().openapi({
              description: "One of the scale's labels when it has one. null or blank removes it.",
            }),
            note: z.string().max(PREDICTED_NOTE_MAX).nullable().optional().openapi({
              description:
                "Staff-only note. Omitted keeps the saved note; null or blank clears it.",
            }),
          })
          .openapi("SavePredictedGradeItem"),
      )
      .min(1)
      .max(500),
  })
  .openapi("SavePredictedGradesBody");

export const studentPredictedGradesSchema = z
  .object({
    student_id: uuidSchema,
    years: z.array(
      z
        .object({
          academic_year_id: uuidSchema,
          academic_year_name: z.string(),
          section_id: uuidSchema.nullable(),
          section_name: z.string().nullable(),
          grade_level_name: z.string().nullable(),
          enabled: z.boolean(),
          visibility: predictedGradesVisibilitySchema,
          can_edit: z.boolean().openapi({
            description:
              "School leadership may change this year's predictions (PUT the section and subject's predicted-grades).",
          }),
          subjects: z
            .array(
              z
                .object({
                  subject_id: uuidSchema,
                  subject_name: z.string(),
                  labels: z.array(z.string()),
                })
                .openapi("PredictedGradeSubjectOption"),
            )
            .openapi({
              description: "Subjects the student takes that year; empty unless can_edit.",
            }),
          terms: z
            .array(
              z
                .object({ term_id: uuidSchema, term_name: z.string() })
                .openapi("PredictedGradeTermOption"),
            )
            .openapi({ description: "The year's terms; empty unless can_edit." }),
          grades: z.array(
            z
              .object({
                term_id: uuidSchema.nullable(),
                term_name: z.string().nullable(),
                subject_id: uuidSchema,
                subject_name: z.string(),
                grade_label: z.string(),
                note: z.string().nullable().openapi({
                  description: "The teacher's note; always null for the student and parents.",
                }),
                updated_at: dateTimeSchema,
              })
              .openapi("StudentPredictedGrade"),
          ),
        })
        .openapi("StudentPredictedGradesYear"),
    ),
  })
  .openapi("StudentPredictedGrades");
