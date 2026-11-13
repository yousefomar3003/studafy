/**
 * Wire schemas for the child comparison report (ST-177).
 *
 * The comparison and breakdown responses are projections of the three shared reporting surfaces,
 * so the shapes here are composed from the existing wire schemas instead of being re-declared:
 * the period/attendance blocks come from the attendance reports module and the per-course grades
 * come from the published grades module. Reusing them is what guarantees the parent comparison
 * renders the exact same attendance percentages and grade rows the attendance summary and
 * published grades APIs already serve.
 */

import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { timetableSettingsSchema } from "../academics/schemas";
import {
  attendanceMetricsSchema,
  attendanceTrendPointSchema,
  reportPeriodSchema,
} from "../attendance/reports/schemas";
import { publishedGradeSchema, publishedTermSummarySchema } from "../grades/published/schemas";

export const childComparisonQuerySchema = z
  .object({
    term_id: uuidSchema.openapi({
      description: "Academic term whose inclusive dates the report is scoped to.",
    }),
  })
  .openapi("ChildComparisonQuery");

export const childBreakdownParamsSchema = z
  .object({
    studentId: uuidSchema.openapi({
      param: { name: "studentId", in: "path" },
      description: "Linked child whose comparison breakdown is requested.",
    }),
  })
  .openapi("ChildBreakdownParams");

export const assignmentCompletionSchema = z
  .object({
    total: z.number().int().nonnegative().openapi({
      description: "Published assignments in the term's classes the child is actively enrolled in.",
    }),
    submitted: z.number().int().nonnegative().openapi({
      description: "Assignments handed in (status submitted, late, graded, or returned).",
    }),
    on_time: z.number().int().nonnegative().openapi({
      description: "Handed-in assignments whose submission is not late.",
    }),
    late: z.number().int().nonnegative().openapi({
      description: "Handed-in assignments flagged late.",
    }),
    completion_percent: z.number().min(0).max(100).openapi({
      description: "100 * submitted / total, rounded to two decimals; 0 when total is zero.",
    }),
  })
  .openapi("AssignmentCompletion");

export const gradeTrendPointSchema = z
  .object({
    term_id: uuidSchema,
    term_name: z.string(),
    term_average_percentage: z.number().min(0).max(100).nullable(),
    term_gpa: z.number().nullable(),
  })
  .openapi("GradeTrendPoint");

export const childComparisonItemSchema = z
  .object({
    student_id: uuidSchema,
    student_name: z.string(),
    admission_number: z.string(),
    grade: z.object({
      term_average_percentage: z.number().min(0).max(100).nullable(),
      term_gpa: z.number().nullable(),
      total_credits: z.number().min(0),
    }),
    grade_trend: z.array(gradeTrendPointSchema),
    attendance: attendanceMetricsSchema,
    assignments: assignmentCompletionSchema,
  })
  .openapi("ChildComparisonItem");

export const childComparisonResponseSchema = z
  .object({
    generated_at: dateTimeSchema,
    period: reportPeriodSchema,
    children: z.array(childComparisonItemSchema),
  })
  .openapi("ChildComparisonReport");

export const childGradeSnapshotSchema = z
  .object({
    grades: z.array(publishedGradeSchema),
    term_summary: publishedTermSummarySchema,
  })
  .openapi("ChildGradeSnapshot");

export const childAttendanceBreakdownSchema = z
  .object({
    totals: attendanceMetricsSchema,
    trends: z.array(attendanceTrendPointSchema),
  })
  .openapi("ChildAttendanceBreakdown");

export const childBreakdownResponseSchema = z
  .object({
    generated_at: dateTimeSchema,
    period: reportPeriodSchema,
    student: z.object({
      student_id: uuidSchema,
      student_name: z.string(),
      admission_number: z.string(),
    }),
    grade_trend: z.array(gradeTrendPointSchema),
    grade: childGradeSnapshotSchema,
    attendance: childAttendanceBreakdownSchema,
    assignments: assignmentCompletionSchema,
  })
  .openapi("ChildComparisonBreakdown");

export const childTimetableParamsSchema = z
  .object({
    studentId: uuidSchema.openapi({
      param: { name: "studentId", in: "path" },
      description: "Linked child whose weekly timetable is requested.",
    }),
  })
  .openapi("ChildTimetableParams");

export const childTimetableSlotSchema = z
  .object({
    id: uuidSchema,
    weekday: z.number().int().min(1).max(7).openapi({
      description: "1=Mon..7=Sun (same numbering as the school's teaching week).",
    }),
    period: z.number().int().min(1),
    // Named, not anonymous: client generators derive a model name from the property name, so an
    // anonymous `room` becomes a second "Room" and overwrites the real Room component (likewise
    // Class, Course and Teacher) in the generated mobile client.
    class: z.object({ id: uuidSchema, code: z.string() }).openapi("ChildTimetableClass"),
    course: z
      .object({ id: uuidSchema, code: z.string(), name: z.string() })
      .openapi("ChildTimetableCourse")
      .nullable(),
    teacher: z
      .object({ id: uuidSchema, name: z.string() })
      .openapi("ChildTimetableTeacher")
      .nullable(),
    room: z.object({ id: uuidSchema, name: z.string() }).openapi("ChildTimetableRoom").nullable(),
  })
  .openapi("ChildTimetableSlot");

export const childTimetableResponseSchema = z
  .object({
    student_id: uuidSchema,
    term_id: uuidSchema.nullable().openapi({
      description: "The school's current term; null when no term is current.",
    }),
    timetable_version_id: uuidSchema.nullable().openapi({
      description: "The current term's approved timetable version; null when none is approved.",
    }),
    settings: timetableSettingsSchema,
    slots: z.array(childTimetableSlotSchema).openapi({
      description:
        "Approved-version slots for the classes the child is actively enrolled in, sorted by " +
        "weekday then period. Empty when no approved version exists.",
    }),
  })
  .openapi("ChildTimetable");
