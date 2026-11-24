import { z } from "@hono/zod-openapi";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { SEATING_STRATEGIES } from "./seating";

/**
 * Exam weeks (000265). Kept flat for the mobile client generator: no .extend (allOf), no per-field
 * description on a referenced enum, no .default on a shared enum (defaults are applied in the
 * service).
 */

const pathUuid = (name: string, description: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: "path" }, description });

/** HH:MM on the school's wall clock (seconds are accepted and dropped). */
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Expected HH:MM")
  .transform((value) => value.slice(0, 5))
  .openapi({ example: "09:00", description: "HH:MM, the school's wall clock." });

const timeOutSchema = z
  .string()
  .openapi({ example: "09:00", description: "HH:MM, the school's wall clock." });

export const EXAM_PERIOD_KINDS = ["midterm", "final", "monthly", "mock", "other"] as const;
export const EXAM_PERIOD_STATUSES = ["draft", "published"] as const;

export const examPeriodKindSchema = z.enum(EXAM_PERIOD_KINDS).openapi("ExamPeriodKind", {
  description: "midterm, final, monthly, mock (a practice round) or other.",
});

export const examPeriodStatusSchema = z.enum(EXAM_PERIOD_STATUSES).openapi("ExamPeriodStatus", {
  description:
    "draft: leadership is building it, nobody else sees it. published: students, parents and " +
    "invigilating teachers see it in the app.",
});

export const seatingStrategySchema = z.enum(SEATING_STRATEGIES).openapi("ExamSeatingStrategy", {
  description:
    "by_section: section by section, alphabetical inside each. alphabetical: everyone by last " +
    "name. mixed: one student from each section in turn, so neighbours are from other sections.",
});

export const examPeriodIdParamSchema = z
  .object({ periodId: pathUuid("periodId", "Exam period UUID.") })
  .openapi("ExamPeriodIdParam");

export const examSlotIdParamSchema = z
  .object({ slotId: pathUuid("slotId", "Exam slot UUID.") })
  .openapi("ExamSlotIdParam");

export const examSeatParamSchema = z
  .object({
    slotId: pathUuid("slotId", "Exam slot UUID."),
    studentId: pathUuid("studentId", "Student UUID."),
  })
  .openapi("ExamSeatParam");

export const examStudentParamSchema = z
  .object({ studentId: pathUuid("studentId", "Student UUID.") })
  .openapi("ExamStudentIdParam");

export const examPeriodListQuerySchema = z.object({
  academic_year_id: z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: { name: "academic_year_id", in: "query" },
      description: "Only this academic year's periods.",
    }),
});

// ---------------------------------------------------------------------------
// Shared references
// ---------------------------------------------------------------------------

const idNameSchema = z.object({ id: uuidSchema, name: z.string() }).openapi("ExamWeeksIdName");

const subjectRefSchema = z
  .object({ id: uuidSchema, code: z.string(), name: z.string() })
  .openapi("ExamWeeksSubject");

const roomRefSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    building: z.string().nullable(),
    floor: z.string().nullable(),
  })
  .openapi("ExamWeeksRoom");

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

const periodShape = {
  id: uuidSchema,
  academic_year_id: uuidSchema,
  term: idNameSchema.nullable(),
  name: z.string(),
  kind: examPeriodKindSchema,
  starts_on: dateSchema,
  ends_on: dateSchema,
  status: examPeriodStatusSchema,
  published_at: dateTimeSchema.nullable(),
  grade_levels: z.array(idNameSchema),
  slot_count: z.number().int(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
};

export const examPeriodSummarySchema = z.object(periodShape).openapi("ExamPeriodSummary");

export const examPeriodListSchema = z
  .object({ periods: z.array(examPeriodSummarySchema) })
  .openapi("ExamPeriodList");

export const examPeriodBodySchema = z
  .object({
    academic_year_id: uuidSchema,
    term_id: uuidSchema.nullable().optional(),
    name: z.string().trim().min(1).max(120),
    kind: examPeriodKindSchema.optional(),
    starts_on: dateSchema,
    ends_on: dateSchema,
    grade_level_ids: z.array(uuidSchema).min(1).max(50),
    status: examPeriodStatusSchema.optional(),
  })
  .openapi("ExamPeriodInput");

export const examSlotRoomSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    building: z.string().nullable(),
    floor: z.string().nullable(),
    capacity: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Seats in an exam: the room's exam capacity, else its capacity." }),
    seated: z.number().int(),
    invigilators: z.array(idNameSchema),
  })
  .openapi("ExamSlotRoom");

export const examSlotSchema = z
  .object({
    id: uuidSchema,
    period_id: uuidSchema,
    subject: subjectRefSchema,
    grade_level: idNameSchema,
    sections: z.array(idNameSchema),
    exam_date: dateSchema,
    starts_at: timeOutSchema,
    ends_at: timeOutSchema,
    assessment: idNameSchema.nullable(),
    notes: z.string().nullable(),
    rooms: z.array(examSlotRoomSchema),
    candidates: z.number().int().openapi({ description: "Students who sit the exam." }),
    seated: z.number().int(),
  })
  .openapi("ExamSlot");

export const examPeriodSchema = z
  .object({ ...periodShape, slots: z.array(examSlotSchema) })
  .openapi("ExamPeriod");

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export const examSlotBodySchema = z
  .object({
    subject_id: uuidSchema,
    grade_level_id: uuidSchema,
    section_ids: z.array(uuidSchema).min(1).max(50),
    exam_date: dateSchema,
    starts_at: timeSchema,
    ends_at: timeSchema,
    assessment_id: uuidSchema.nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    room_ids: z
      .array(uuidSchema)
      .max(50)
      .optional()
      .openapi({ description: "The rooms in filling order. Rooms taken off unseat their seats." }),
  })
  .openapi("ExamSlotInput");

export const examSeatingBodySchema = z
  .object({
    strategy: seatingStrategySchema,
    keep_existing: z
      .boolean()
      .optional()
      .openapi({ description: "Keep every still-valid seat (default true)." }),
  })
  .openapi("ExamSeatingInput");

export const examSeatBodySchema = z
  .object({ room_id: uuidSchema, seat_number: z.number().int().min(1).max(10000) })
  .openapi("ExamSeatInput");

export const examInvigilatorsBodySchema = z
  .object({
    rooms: z
      .array(
        z
          .object({ room_id: uuidSchema, teacher_ids: z.array(uuidSchema).max(10) })
          .openapi("ExamRoomInvigilatorsInput"),
      )
      .max(50),
  })
  .openapi("ExamInvigilatorsInput");

// ---------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------

const seatStudentShape = {
  student_id: uuidSchema,
  first_name: z.string(),
  last_name: z.string(),
  admission_number: z.string(),
  section: idNameSchema,
};

export const examSeatSchema = z
  .object({ ...seatStudentShape, room_id: uuidSchema, seat_number: z.number().int() })
  .openapi("ExamSeat");

export const examUnseatedSchema = z.object(seatStudentShape).openapi("ExamUnseatedStudent");

export const examSlotSeatingSchema = z
  .object({
    slot_id: uuidSchema,
    seats: z.array(examSeatSchema).openapi({ description: "By room (filling order), then seat." }),
    unseated: z.array(examUnseatedSchema),
  })
  .openapi("ExamSlotSeating");

export const examPeriodSeatingSchema = z
  .object({ period_id: uuidSchema, slots: z.array(examSlotSeatingSchema) })
  .openapi("ExamPeriodSeating");

export const examSeatingResultSchema = z
  .object({
    slot_id: uuidSchema,
    seats: z.array(examSeatSchema),
    unseated: z.array(examUnseatedSchema),
    kept: z.number().int().openapi({ description: "Existing seats left where they were." }),
  })
  .openapi("ExamSeatingResult");

// ---------------------------------------------------------------------------
// Clashes
// ---------------------------------------------------------------------------

export const EXAM_CLASH_TYPES = [
  "teacher_double_booked",
  "student_double_booked",
  "room_over_capacity",
  "seat_double_booked",
  "room_without_capacity",
  "insufficient_capacity",
  "unseated_students",
  "no_invigilator",
  "on_holiday",
] as const;

export const examClashSchema = z
  .object({
    type: z.enum(EXAM_CLASH_TYPES).openapi("ExamClashType"),
    severity: z.enum(["error", "warning"]).openapi("ExamClashSeverity"),
    slot_ids: z.array(uuidSchema),
    room_ids: z.array(uuidSchema),
    teacher: idNameSchema.nullable(),
    students: z.array(idNameSchema),
    seat_number: z.number().int().nullable(),
    seated: z.number().int().nullable(),
    capacity: z.number().int().nullable(),
    count: z.number().int().nullable(),
    holiday: z.string().nullable(),
  })
  .openapi("ExamClash");

export const examClashListSchema = z
  .object({ period_id: uuidSchema, clashes: z.array(examClashSchema) })
  .openapi("ExamClashList");

// ---------------------------------------------------------------------------
// The apps: a student's exam timetable and a teacher's invigilation duties
// ---------------------------------------------------------------------------

export const studentExamSlotSchema = z
  .object({
    id: uuidSchema,
    subject: subjectRefSchema,
    exam_date: dateSchema,
    starts_at: timeOutSchema,
    ends_at: timeOutSchema,
    room: roomRefSchema.nullable(),
    seat_number: z.number().int().nullable(),
  })
  .openapi("StudentExamSlot");

export const studentExamPeriodSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    kind: examPeriodKindSchema,
    starts_on: dateSchema,
    ends_on: dateSchema,
    slots: z.array(studentExamSlotSchema),
  })
  .openapi("StudentExamPeriod");

export const studentExamTimetableSchema = z
  .object({
    student_id: uuidSchema,
    timezone: z.string().openapi({ description: "The school's timezone (IANA), e.g. Asia/Amman." }),
    periods: z.array(studentExamPeriodSchema),
  })
  .openapi("StudentExamTimetable");

export const invigilationDutySchema = z
  .object({
    slot_id: uuidSchema,
    period: idNameSchema,
    subject: subjectRefSchema,
    grade_level: idNameSchema,
    sections: z.array(idNameSchema),
    exam_date: dateSchema,
    starts_at: timeOutSchema,
    ends_at: timeOutSchema,
    room: roomRefSchema,
  })
  .openapi("InvigilationDuty");

export const invigilationDutyListSchema = z
  .object({
    timezone: z.string().openapi({ description: "The school's timezone (IANA), e.g. Asia/Amman." }),
    duties: z.array(invigilationDutySchema),
  })
  .openapi("InvigilationDutyList");
