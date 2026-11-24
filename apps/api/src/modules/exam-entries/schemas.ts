import { z } from "@hono/zod-openapi";
import { EXAM_ENTRY_LIMITS, EXAM_ENTRY_STATUSES } from "@studafy/grading-engine";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

/**
 * Exam entries (000261): sessions of a catalogue external exam and the students entered for them.
 * Shared enums are referenced plainly (no per-field description, no default) so the generated Dart
 * client compiles; defaults are applied in the handlers.
 */

const pathUuid = (name: string, description: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: "path" }, description });

const text = (max: number) => z.string().trim().min(1).max(max);

export const examSessionIdParamSchema = z
  .object({ sessionId: pathUuid("sessionId", "External exam session UUID.") })
  .openapi("ExamSessionIdParam");

export const examEntryIdParamSchema = z
  .object({ entryId: pathUuid("entryId", "Exam entry UUID.") })
  .openapi("ExamEntryIdParam");

export const examEntryStudentParamSchema = z
  .object({ studentId: pathUuid("studentId", "Student UUID.") })
  .openapi("ExamEntryStudentIdParam");

export const examSessionListQuerySchema = z.object({
  exam_id: z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: { name: "exam_id", in: "query" },
      description: "Only this exam's sessions.",
    }),
});

export const examEntryExportQuerySchema = z.object({
  include_drafts: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
    .openapi({
      param: { name: "include_drafts", in: "query" },
      description: "Default false: only entered and withdrawn entries, as sent to the board.",
    }),
});

export const examEntryStatusSchema = z.enum(EXAM_ENTRY_STATUSES).openapi("ExamEntryStatus", {
  description:
    "draft: planned, not sent to the board. entered: sent to the board. withdrawn: withdrawn after entry.",
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const sessionDates = {
  entry_deadline: dateSchema.nullable().optional(),
  starts_on: dateSchema.nullable().optional(),
  ends_on: dateSchema.nullable().optional().openapi({ description: "Needs starts_on." }),
  results_date: dateSchema.nullable().optional(),
  note: text(EXAM_ENTRY_LIMITS.noteLength).nullable().optional(),
};

export const createExamSessionBodySchema = z
  .object({
    exam_id: uuidSchema,
    series: text(EXAM_ENTRY_LIMITS.seriesLength).openapi({
      description: "The series as the board names it, e.g. May/June 2027.",
    }),
    ...sessionDates,
  })
  .openapi("CreateExamSessionBody");

export const updateExamSessionBodySchema = z
  .object({ series: text(EXAM_ENTRY_LIMITS.seriesLength), ...sessionDates })
  .openapi("UpdateExamSessionBody");

const sessionExamSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    per_subject: z.boolean(),
    archived: z.boolean(),
  })
  .openapi("ExamSessionExam");

export const examSessionSchema = z
  .object({
    id: uuidSchema,
    exam: sessionExamSchema,
    series: z.string(),
    entry_deadline: dateSchema.nullable(),
    starts_on: dateSchema.nullable(),
    ends_on: dateSchema.nullable(),
    results_date: dateSchema.nullable(),
    note: z.string().nullable(),
    draft_count: z.number().int(),
    entered_count: z.number().int(),
    withdrawn_count: z.number().int(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("ExamSession");

export const examSessionListSchema = z
  .object({ sessions: z.array(examSessionSchema) })
  .openapi("ExamSessionList");

// ---------------------------------------------------------------------------
// Entries (leadership)
// ---------------------------------------------------------------------------

export const examEntrySubjectBodySchema = z
  .object({
    subject_id: uuidSchema,
    tier: text(EXAM_ENTRY_LIMITS.tierLength).nullable().optional(),
    option_code: text(EXAM_ENTRY_LIMITS.optionCodeLength).nullable().optional(),
  })
  .openapi("ExamEntrySubjectBody");

const subjectsBody = z
  .array(examEntrySubjectBodySchema)
  .max(EXAM_ENTRY_LIMITS.maxSubjects)
  .openapi({
    description: "At least one for a per-subject exam (IGCSE, AP...); none otherwise.",
  });

export const bulkCreateExamEntriesBodySchema = z
  .object({
    student_ids: z.array(uuidSchema).max(EXAM_ENTRY_LIMITS.maxBatch).optional(),
    section_id: uuidSchema.optional().openapi({ description: "Every student placed in it." }),
    grade_level_id: uuidSchema.optional().openapi({
      description: "Every student placed in one of its sections in academic_year_id.",
    }),
    academic_year_id: uuidSchema.optional(),
    subjects: subjectsBody,
    status: examEntryStatusSchema.optional(),
  })
  .openapi("BulkCreateExamEntriesBody", {
    description:
      "Students from the list, a section and/or a grade (enrolled students only for a section or " +
      "grade). Students already entered get the subjects they lack; withdrawn entries are skipped. " +
      "status: draft (default) or entered.",
  });

export const bulkCreateExamEntriesResultSchema = z
  .object({
    created: z.number().int(),
    updated: z.number().int().openapi({ description: "Existing entries that gained subjects." }),
    unchanged: z.number().int(),
    skipped_withdrawn: z.number().int(),
  })
  .openapi("BulkCreateExamEntriesResult");

export const updateExamEntryBodySchema = z
  .object({
    candidate_number: text(EXAM_ENTRY_LIMITS.candidateNumberLength).nullable(),
    note: text(EXAM_ENTRY_LIMITS.noteLength).nullable().optional(),
    subjects: subjectsBody,
  })
  .openapi("UpdateExamEntryBody");

export const changeExamEntryStatusBodySchema = z
  .object({
    entry_ids: z.array(uuidSchema).min(1).max(EXAM_ENTRY_LIMITS.maxBatch),
    status: examEntryStatusSchema,
  })
  .openapi("ChangeExamEntryStatusBody", {
    description:
      "draft → entered, entered → withdrawn, withdrawn → entered (reinstate). Entries already in " +
      "the status are left as they are.",
  });

export const changeExamEntryStatusResultSchema = z
  .object({ updated: z.number().int() })
  .openapi("ChangeExamEntryStatusResult");

export const assignCandidateNumbersBodySchema = z
  .object({
    start: z.number().int().min(0).max(999_999_999),
    width: z.number().int().min(0).max(EXAM_ENTRY_LIMITS.maxNumberWidth).optional(),
    prefix: z.string().trim().max(EXAM_ENTRY_LIMITS.candidatePrefixLength).optional(),
  })
  .openapi("AssignCandidateNumbersBody", {
    description:
      "Numbers the session's draft and entered entries that have none, by student name, from " +
      "start (zero-padded to width, after prefix), skipping numbers already used.",
  });

export const assignCandidateNumbersResultSchema = z
  .object({ assigned: z.number().int() })
  .openapi("AssignCandidateNumbersResult");

const entrySubjectSchema = z
  .object({
    subject_id: uuidSchema,
    code: z.string(),
    name: z.string(),
    tier: z.string().nullable(),
    option_code: z.string().nullable(),
  })
  .openapi("ExamEntrySubject");

export const examEntrySchema = z
  .object({
    id: uuidSchema,
    session_id: uuidSchema,
    student: z
      .object({
        id: uuidSchema,
        admission_number: z.string(),
        first_name: z.string(),
        last_name: z.string(),
        grade_level_name: z.string().nullable().openapi({ description: "Latest placement." }),
        section_name: z.string().nullable(),
      })
      .openapi("ExamEntryStudent"),
    candidate_number: z.string().nullable(),
    status: examEntryStatusSchema,
    note: z.string().nullable(),
    subjects: z.array(entrySubjectSchema),
    result_count: z.number().int().openapi({ description: "Results recorded from this entry." }),
    entered_at: dateTimeSchema.nullable(),
    withdrawn_at: dateTimeSchema.nullable(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("ExamEntry");

export const examSessionEntriesSchema = z
  .object({
    session: examSessionSchema,
    entries: z.array(examEntrySchema),
    subject_counts: z.array(
      z
        .object({
          subject_id: uuidSchema,
          code: z.string(),
          name: z.string(),
          draft: z.number().int(),
          entered: z.number().int(),
          withdrawn: z.number().int(),
        })
        .openapi("ExamSessionSubjectCount"),
    ),
  })
  .openapi("ExamSessionEntries");

// ---------------------------------------------------------------------------
// A student's entries (students, parents, staff)
// ---------------------------------------------------------------------------

export const studentExamEntrySchema = z
  .object({
    id: uuidSchema,
    exam: z
      .object({ id: uuidSchema, code: z.string(), name: z.string() })
      .openapi("StudentExamEntryExam"),
    session: z
      .object({
        id: uuidSchema,
        series: z.string(),
        entry_deadline: dateSchema.nullable(),
        starts_on: dateSchema.nullable(),
        ends_on: dateSchema.nullable(),
        results_date: dateSchema.nullable(),
      })
      .openapi("StudentExamEntrySession"),
    candidate_number: z.string().nullable(),
    status: examEntryStatusSchema,
    subjects: z.array(
      z
        .object({
          subject: z
            .object({ id: uuidSchema, code: z.string(), name: z.string() })
            .openapi("StudentExamEntrySubjectRef")
            .nullable(),
          tier: z.string().nullable(),
          option_code: z.string().nullable(),
        })
        .openapi("StudentExamEntrySubject"),
    ),
    entered_at: dateTimeSchema.nullable(),
    withdrawn_at: dateTimeSchema.nullable(),
  })
  .openapi("StudentExamEntry");

export const studentExamEntryListSchema = z
  .object({ entries: z.array(studentExamEntrySchema) })
  .openapi("StudentExamEntryList");
