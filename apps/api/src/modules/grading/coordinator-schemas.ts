import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { sheetStatusSchema } from "./schemas";

/** Subject coordinators (000261). */

export const COORDINATOR_GRADE_LEVELS_MAX = 50;

export const coordinatorIdParamSchema = z
  .object({
    coordinatorId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "coordinatorId", in: "path" },
        description: "Subject coordinator assignment UUID.",
      }),
  })
  .openapi("SubjectCoordinatorIdParam");

const gradeLevelIdsSchema = z.array(uuidSchema).max(COORDINATOR_GRADE_LEVELS_MAX).openapi({
  description:
    "The grade levels the assignment covers. Empty: every grade level taught the subject that year.",
});

export const subjectCoordinatorBodySchema = z
  .object({
    subject_id: uuidSchema,
    user_id: uuidSchema.openapi({
      description: "A member of the school's staff, usually a teacher.",
    }),
    grade_level_ids: gradeLevelIdsSchema,
  })
  .openapi("SubjectCoordinatorBody");

export const subjectCoordinatorUpdateBodySchema = z
  .object({ grade_level_ids: gradeLevelIdsSchema })
  .openapi("SubjectCoordinatorUpdateBody");

const gradeLevelSchema = z
  .object({ id: uuidSchema, name: z.string() })
  .openapi("SubjectCoordinatorGradeLevel");

export const subjectCoordinatorSchema = z
  .object({
    id: uuidSchema,
    academic_year_id: uuidSchema,
    subject_id: uuidSchema,
    subject_code: z.string(),
    subject_name: z.string(),
    user_id: uuidSchema,
    user_name: z.string(),
    grade_levels: z.array(gradeLevelSchema).openapi({
      description: "Empty: every grade level taught the subject that year.",
    }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("SubjectCoordinator");

export const subjectCoordinatorListSchema = z
  .object({ coordinators: z.array(subjectCoordinatorSchema) })
  .openapi("SubjectCoordinatorList");

export const myCoordinatedSubjectsQuerySchema = z
  .object({
    academic_year_id: uuidSchema.optional().openapi({
      description: "The academic year; omit for the latest active or finalized year.",
    }),
  })
  .openapi("MyCoordinatedSubjectsQuery");

const coordinatedSheetSchema = z
  .object({
    term_id: uuidSchema.nullable(),
    term_name: z.string().nullable(),
    status: sheetStatusSchema,
  })
  .openapi("CoordinatedSheetStatus");

const coordinatedResultSchema = z
  .object({
    term_id: uuidSchema.nullable(),
    term_name: z.string().nullable(),
    average_percentage: z.number().nullable(),
    student_count: z.number().int().openapi({
      description: "Students with a complete result in the subject.",
    }),
    finalized_at: dateTimeSchema,
  })
  .openapi("CoordinatedSectionResult");

const coordinatedSectionSchema = z
  .object({
    section_id: uuidSchema,
    section_name: z.string(),
    grade_level_id: uuidSchema,
    grade_level_name: z.string(),
    teacher_names: z.array(z.string()).openapi({
      description: "The teachers assigned to the subject in the section.",
    }),
    student_count: z.number().int().openapi({
      description: "Students taking the subject (exempt students are not counted).",
    }),
    average_percentage: z.number().nullable().openapi({
      description:
        "The mean of the students' current percentages from the marks recorded so far (provisional where incomplete); null without any.",
    }),
    complete_count: z.number().int().openapi({
      description: "Students whose current result is complete.",
    }),
    sheets: z.array(coordinatedSheetSchema).openapi({
      description: "Each period's mark sheet status, terms in order then the annual period.",
    }),
    results: z.array(coordinatedResultSchema).openapi({
      description: "The subject's finalized results in the section, one per finalized period.",
    }),
  })
  .openapi("CoordinatedSection");

const coordinatedSubjectSchema = z
  .object({
    coordinator_id: uuidSchema,
    subject_id: uuidSchema,
    subject_code: z.string(),
    subject_name: z.string(),
    grade_level_ids: z.array(uuidSchema).openapi({
      description: "Empty: every grade level taught the subject.",
    }),
    sections: z.array(coordinatedSectionSchema),
  })
  .openapi("CoordinatedSubject");

export const myCoordinatedSubjectsSchema = z
  .object({
    academic_year_id: uuidSchema.nullable(),
    subjects: z.array(coordinatedSubjectSchema),
  })
  .openapi("MyCoordinatedSubjects");
