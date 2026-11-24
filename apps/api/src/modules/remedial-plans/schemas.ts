import { z } from "@hono/zod-openapi";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import {
  REMEDIAL_LIMITS,
  REMEDIAL_PLAN_ACCESS,
  REMEDIAL_PLAN_REASONS,
  REMEDIAL_PLAN_STATUSES,
  REMEDIAL_STAFF_ACCESS,
} from "./service";

/**
 * Remedial plans (000268). Enums are named once and referenced plainly (a per-field description or
 * default on a referenced enum breaks the mobile client generator); defaults are applied in the
 * service.
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
    .optional()
    .openapi({ param: { name, in: "query" }, description });

export const remedialPlanIdParamSchema = z
  .object({ planId: pathUuid("planId", "Remedial plan UUID.") })
  .openapi("RemedialPlanIdParam");

export const remedialStudentParamSchema = z
  .object({ studentId: pathUuid("studentId", "Student UUID.") })
  .openapi("RemedialStudentIdParam");

export const remedialSectionSubjectParamSchema = z
  .object({
    sectionId: pathUuid("sectionId", "Section UUID."),
    subjectId: pathUuid("subjectId", "Subject UUID."),
  })
  .openapi("RemedialSectionSubjectParam");

export const remedialPlanStatusSchema = z
  .enum(REMEDIAL_PLAN_STATUSES)
  .openapi("RemedialPlanStatus", {
    description:
      "open -> in_progress -> achieved or closed. A plan moves forward only; achieved and closed plans " +
      "are history (read-only, notes still allowed).",
  });

export const remedialPlanReasonSchema = z
  .enum(REMEDIAL_PLAN_REASONS)
  .openapi("RemedialPlanReason", {
    description:
      "below_pass: the student's current marks are below the subject's pass percentage. " +
      "teacher_concern: opened on the teacher's judgement.",
  });

export const remedialPlanAccessSchema = z.enum(REMEDIAL_PLAN_ACCESS).openapi("RemedialPlanAccess", {
  description:
    "How the caller reaches the plan: leadership, the section's teacher of the subject, the " +
    "subject's coordinator (follow-up only), or family (the student or a linked parent, read-only).",
});

export const remedialAuthorAccessSchema = z
  .enum(REMEDIAL_STAFF_ACCESS)
  .openapi("RemedialPlanAuthorAccess", {
    description: "How the author reached the plan when writing.",
  });

export const remedialNoteKindSchema = z
  .enum(["note", "status_change"])
  .openapi("RemedialNoteKind", {
    description: "note: a progress or follow-up note. status_change: the plan moved to new_status.",
  });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Spread into the summary and the detail (not .extend: that becomes an allOf, which the mobile
// client generator does not flatten).
const summaryShape = {
  id: uuidSchema,
  academic_year_id: uuidSchema,
  term_id: uuidSchema.nullable(),
  term_name: z.string().nullable(),
  section_id: uuidSchema,
  section_name: z.string(),
  grade_level_id: uuidSchema,
  grade_level_name: z.string(),
  student_id: uuidSchema,
  student_first_name: z.string(),
  student_last_name: z.string(),
  admission_number: z.string(),
  subject_id: uuidSchema,
  subject_name: z.string(),
  reason: remedialPlanReasonSchema,
  status: remedialPlanStatusSchema,
  shared_with_family: z.boolean(),
  next_review_on: dateSchema.nullable().openapi({
    description: "The earliest review not done yet, or null.",
  }),
  overdue: z.boolean().openapi({
    description:
      "An open or in-progress plan with a review date before today (school time) not done yet.",
  }),
  last_note_at: dateTimeSchema.nullable(),
  created_by_name: z.string().nullable(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
};

export const remedialPlanSummarySchema = z.object(summaryShape).openapi("RemedialPlanSummary");

const reviewSchema = z
  .object({
    review_on: dateSchema,
    completed_at: dateTimeSchema.nullable().openapi({
      description: "When a follow-up note on or after the date completed it.",
    }),
    overdue: z.boolean(),
  })
  .openapi("RemedialPlanReview");

const noteSchema = z
  .object({
    id: uuidSchema,
    kind: remedialNoteKindSchema,
    body: z.string().nullable(),
    // Plain text rather than the nullable enum (a nullable referenced enum becomes a wrapper class
    // the mobile client generator cannot compile).
    new_status: z.string().nullable().openapi({
      description: "For a status_change: the RemedialPlanStatus the plan moved to.",
    }),
    internal: z.boolean(),
    author_name: z.string().nullable(),
    author_access: remedialAuthorAccessSchema,
    created_at: dateTimeSchema,
  })
  .openapi("RemedialPlanNote");

export const remedialPlanDetailSchema = z
  .object({
    ...summaryShape,
    reason_note: z.string().nullable(),
    targets: z.string().openapi({ description: "The skills or outcomes the plan targets." }),
    actions: z.string(),
    start_percentage: z.number().nullable().openapi({
      description: "The student's current or provisional percentage when the plan was opened.",
    }),
    pass_percentage: z.number().nullable(),
    reviews: z.array(reviewSchema),
    notes: z.array(noteSchema).openapi({
      description: "The timeline, oldest first. The student and parents never see internal notes.",
    }),
    access: remedialPlanAccessSchema,
    can_edit: z.boolean().openapi({
      description:
        "The caller may change the plan (its teacher or leadership, the plan active and the year open).",
    }),
    can_add_note: z.boolean().openapi({
      description: "The caller follows the plan up (its teacher, the coordinator, leadership).",
    }),
    family_sharing_enabled: z.boolean().openapi({
      description: "The school lets plans be shared with the student and parents.",
    }),
  })
  .openapi("RemedialPlan");

export const remedialPlanListQuerySchema = z.object({
  academic_year_id: queryUuid(
    "academic_year_id",
    "The academic year; omit for the latest active or finalized year.",
  ),
  grade_level_id: queryUuid("grade_level_id", "Only this grade level."),
  section_id: queryUuid("section_id", "Only this section."),
  subject_id: queryUuid("subject_id", "Only this subject."),
  status: remedialPlanStatusSchema.optional(),
  overdue: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      param: { name: "overdue", in: "query" },
      description: "true: only plans with an overdue review.",
    }),
});

export const remedialPlanListSchema = z
  .object({
    academic_year_id: uuidSchema.nullable(),
    counts: z
      .object({
        open: z.number().int(),
        in_progress: z.number().int(),
        achieved: z.number().int(),
        closed: z.number().int(),
        overdue: z.number().int(),
      })
      .openapi("RemedialPlanCounts", {
        description: "Across the year's plans the caller follows, before the other filters.",
      }),
    plans: z.array(remedialPlanSummarySchema),
    truncated: z.boolean().openapi({
      description: `More than ${REMEDIAL_LIMITS.listMax} plans matched; narrow the filters.`,
    }),
  })
  .openapi("RemedialPlanList");

export const sectionRemedialQuerySchema = z.object({
  term_id: queryUuid(
    "term_id",
    "The term the suggestions are worked out for; omit for the whole year.",
  ),
});

const suggestionSchema = z
  .object({
    student_id: uuidSchema,
    first_name: z.string(),
    last_name: z.string(),
    admission_number: z.string(),
    percentage: z.number().openapi({
      description: "The current percentage from the marks recorded so far.",
    }),
    provisional: z.boolean().openapi({
      description: "Some marks are still missing, so the percentage is a preview.",
    }),
    active_plan_id: uuidSchema.nullable().openapi({
      description: "The student's open or in-progress plan in the subject for this period, if any.",
    }),
  })
  .openapi("RemedialSuggestion");

export const sectionRemedialPlansSchema = z
  .object({
    section_id: uuidSchema,
    section_name: z.string(),
    grade_level_name: z.string(),
    academic_year_id: uuidSchema,
    subject_id: uuidSchema,
    subject_name: z.string(),
    term_id: uuidSchema.nullable(),
    terms: z
      .array(z.object({ term_id: uuidSchema, term_name: z.string() }).openapi("RemedialTermOption"))
      .openapi({ description: "The year's terms; a null term_id is the whole year." }),
    access: remedialAuthorAccessSchema,
    can_create: z.boolean().openapi({
      description: "The caller teaches the subject here or is leadership, and the year is open.",
    }),
    family_sharing_enabled: z.boolean(),
    pass_percentage: z.number().nullable().openapi({
      description: "The subject's pass percentage; null for a descriptive subject.",
    }),
    students: z
      .array(
        z
          .object({
            student_id: uuidSchema,
            first_name: z.string(),
            last_name: z.string(),
            admission_number: z.string(),
          })
          .openapi("RemedialRosterStudent"),
      )
      .openapi({ description: "Every student taking the subject here, to open a plan for." }),
    suggestions: z.array(suggestionSchema).openapi({
      description:
        "Students below the pass percentage on their current marks for the period, lowest first.",
    }),
    plans: z.array(remedialPlanSummarySchema).openapi({
      description: "Every plan of the section's subject this year, active first.",
    }),
  })
  .openapi("SectionRemedialPlans");

export const studentRemedialPlansSchema = z
  .object({
    student_id: uuidSchema,
    plans: z.array(remedialPlanDetailSchema),
  })
  .openapi("StudentRemedialPlans");

export const remedialSettingsSchema = z
  .object({
    family_visible: z.boolean().openapi({
      description:
        "Teachers may share plans with the student and linked parents (each plan stays staff-only unless shared).",
    }),
  })
  .openapi("RemedialPlanSettings");

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const reviewDatesSchema = z
  .array(dateSchema)
  .max(REMEDIAL_LIMITS.reviewDates)
  .openapi({ description: "Review dates; duplicates are ignored." });

export const createRemedialPlanBodySchema = z
  .object({
    section_id: uuidSchema,
    subject_id: uuidSchema,
    student_id: uuidSchema,
    term_id: uuidSchema.nullable().openapi({ description: "The term, or null for the year." }),
    reason: remedialPlanReasonSchema,
    reason_note: z.string().max(REMEDIAL_LIMITS.reasonNote).nullable().optional(),
    targets: z.string().min(1).max(REMEDIAL_LIMITS.targets),
    actions: z.string().min(1).max(REMEDIAL_LIMITS.actions),
    review_dates: reviewDatesSchema,
    shared_with_family: z.boolean(),
  })
  .openapi("CreateRemedialPlanBody");

export const updateRemedialPlanBodySchema = z
  .object({
    reason: remedialPlanReasonSchema.optional(),
    reason_note: z.string().max(REMEDIAL_LIMITS.reasonNote).nullable().optional(),
    targets: z.string().min(1).max(REMEDIAL_LIMITS.targets).optional(),
    actions: z.string().min(1).max(REMEDIAL_LIMITS.actions).optional(),
    review_dates: reviewDatesSchema.optional(),
    status: remedialPlanStatusSchema.optional(),
    status_note: z.string().max(REMEDIAL_LIMITS.note).nullable().optional().openapi({
      description: "Shown on the timeline with a status change.",
    }),
    shared_with_family: z.boolean().optional(),
  })
  .openapi("UpdateRemedialPlanBody");

export const addRemedialNoteBodySchema = z
  .object({
    body: z.string().min(1).max(REMEDIAL_LIMITS.note),
    internal: z.boolean().openapi({
      description: "Staff only: never shown to the student or parents.",
    }),
  })
  .openapi("AddRemedialPlanNoteBody");
