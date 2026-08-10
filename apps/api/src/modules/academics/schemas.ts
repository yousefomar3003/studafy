import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema, dateSchema } from "@studafy/shared-schemas";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const academicYearStatusSchema = z
  .enum(["planned", "active", "closed", "archived"])
  .openapi({ description: "Lifecycle state of an academic year." });

export type AcademicYearStatus = z.infer<typeof academicYearStatusSchema>;

// ---------------------------------------------------------------------------
// Academic Year
// ---------------------------------------------------------------------------

export const academicYearSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    code: z
      .string()
      .openapi({ description: "Short unique code within the school.", example: "2025-2026" }),
    name: z
      .string()
      .openapi({ description: "Human-readable name.", example: "Academic Year 2025-2026" }),
    starts_on: dateSchema.openapi({ description: "First day of the academic year." }),
    ends_on: dateSchema.openapi({ description: "Last day of the academic year." }),
    status: academicYearStatusSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("AcademicYear");

export type AcademicYear = z.infer<typeof academicYearSchema>;

export const createAcademicYearBodySchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(50)
      .openapi({ description: "Short unique code.", example: "2025-2026" }),
    name: z
      .string()
      .min(1)
      .max(200)
      .openapi({ description: "Human-readable name.", example: "Academic Year 2025-2026" }),
    starts_on: z.string().date().openapi({ description: "First day (YYYY-MM-DD)." }),
    ends_on: z
      .string()
      .date()
      .openapi({ description: "Last day (YYYY-MM-DD). Must be after starts_on." }),
    status: academicYearStatusSchema.default("planned"),
  })
  .openapi("CreateAcademicYearBody");

export type CreateAcademicYearBody = z.infer<typeof createAcademicYearBodySchema>;

export const updateAcademicYearBodySchema = z
  .object({
    code: z.string().min(1).max(50).optional().openapi({ description: "Short unique code." }),
    name: z.string().min(1).max(200).optional().openapi({ description: "Human-readable name." }),
    starts_on: z.string().date().optional().openapi({ description: "First day (YYYY-MM-DD)." }),
    ends_on: z.string().date().optional().openapi({ description: "Last day (YYYY-MM-DD)." }),
    status: academicYearStatusSchema.optional(),
  })
  .openapi("UpdateAcademicYearBody");

export type UpdateAcademicYearBody = z.infer<typeof updateAcademicYearBodySchema>;

export const academicYearListSchema = z
  .object({
    academic_years: z.array(academicYearSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("AcademicYearList");

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export const termSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    academic_year_id: uuidSchema.openapi({ description: "Parent academic year." }),
    code: z
      .string()
      .openapi({ description: "Short unique code within the academic year.", example: "T1" }),
    name: z.string().openapi({ description: "Human-readable name.", example: "Term 1" }),
    sequence_number: z
      .number()
      .int()
      .openapi({ description: "Ordinal position within the year.", example: 1 }),
    starts_on: dateSchema.openapi({ description: "First day of the term." }),
    ends_on: dateSchema.openapi({ description: "Last day of the term." }),
    status: academicYearStatusSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Term");

export type Term = z.infer<typeof termSchema>;

export const createTermBodySchema = z
  .object({
    academic_year_id: uuidSchema.openapi({ description: "Parent academic year." }),
    code: z.string().min(1).max(50).openapi({ description: "Short unique code.", example: "T1" }),
    name: z
      .string()
      .min(1)
      .max(200)
      .openapi({ description: "Human-readable name.", example: "Term 1" }),
    sequence_number: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "Ordinal position (1-based)." }),
    starts_on: z.string().date().openapi({ description: "First day (YYYY-MM-DD)." }),
    ends_on: z.string().date().openapi({ description: "Last day (YYYY-MM-DD)." }),
    status: academicYearStatusSchema.default("planned"),
  })
  .openapi("CreateTermBody");

export type CreateTermBody = z.infer<typeof createTermBodySchema>;

export const updateTermBodySchema = z
  .object({
    code: z.string().min(1).max(50).optional().openapi({ description: "Short unique code." }),
    name: z.string().min(1).max(200).optional().openapi({ description: "Human-readable name." }),
    sequence_number: z
      .number()
      .int()
      .min(1)
      .optional()
      .openapi({ description: "Ordinal position." }),
    starts_on: z.string().date().optional().openapi({ description: "First day (YYYY-MM-DD)." }),
    ends_on: z.string().date().optional().openapi({ description: "Last day (YYYY-MM-DD)." }),
    status: academicYearStatusSchema.optional(),
  })
  .openapi("UpdateTermBody");

export type UpdateTermBody = z.infer<typeof updateTermBodySchema>;

export const termListSchema = z
  .object({
    terms: z.array(termSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("TermList");

// ---------------------------------------------------------------------------
// Rollover
// ---------------------------------------------------------------------------

export const rolloverResponseSchema = z
  .object({
    prior_year_id: uuidSchema.nullable().openapi({
      description: "ID of the previously active year, or null if none existed.",
    }),
    prior_year_status: academicYearStatusSchema.nullable().openapi({
      description: "Status the prior year was set to, or null.",
    }),
    new_year_id: uuidSchema.openapi({ description: "ID of the newly activated year." }),
    new_year_status: z.literal("active").openapi({ description: "The target year is now active." }),
    enrollments_archived: z.number().int().openapi({
      description: "Number of enrollments transitioned to completed.",
    }),
  })
  .openapi("RolloverResult");

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const yearIdParamSchema = z
  .object({
    yearId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "yearId", in: "path" },
        description: "Academic year UUID.",
      }),
  })
  .openapi("YearIdParam");

export const termIdParamSchema = z
  .object({
    termId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "termId", in: "path" },
        description: "Term UUID.",
      }),
  })
  .openapi("TermIdParam");

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

export const academicYearQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    status: academicYearStatusSchema.optional(),
  })
  .openapi("AcademicYearQuery");

export const termQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    status: academicYearStatusSchema.optional(),
  })
  .openapi("TermQuery");

// ---------------------------------------------------------------------------
// Catalog status (shared by subjects and courses)
// ---------------------------------------------------------------------------

export const catalogStatusSchema = z
  .enum(["draft", "active", "inactive", "archived"])
  .openapi({ description: "Lifecycle state of a catalog entity (subject or course)." });

export type CatalogStatus = z.infer<typeof catalogStatusSchema>;

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

export const subjectSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    code: z
      .string()
      .openapi({ description: "Short unique code within the school.", example: "MATH" }),
    name: z.string().openapi({ description: "Human-readable name.", example: "Mathematics" }),
    description: z
      .string()
      .nullable()
      .openapi({ description: "Optional description.", example: "Core mathematics curriculum" }),
    status: catalogStatusSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Subject");

export type Subject = z.infer<typeof subjectSchema>;

export const createSubjectBodySchema = z
  .object({
    code: z.string().min(1).max(50).openapi({ description: "Short unique code.", example: "MATH" }),
    name: z
      .string()
      .min(1)
      .max(200)
      .openapi({ description: "Human-readable name.", example: "Mathematics" }),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .openapi({ description: "Optional description." }),
    status: catalogStatusSchema.default("draft"),
  })
  .openapi("CreateSubjectBody");

export type CreateSubjectBody = z.infer<typeof createSubjectBodySchema>;

export const updateSubjectBodySchema = z
  .object({
    code: z.string().min(1).max(50).optional().openapi({ description: "Short unique code." }),
    name: z.string().min(1).max(200).optional().openapi({ description: "Human-readable name." }),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .openapi({ description: "Optional description." }),
    status: catalogStatusSchema.optional(),
  })
  .openapi("UpdateSubjectBody");

export type UpdateSubjectBody = z.infer<typeof updateSubjectBodySchema>;

export const subjectListSchema = z
  .object({
    subjects: z.array(subjectSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("SubjectList");

export const subjectQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    status: catalogStatusSchema.optional(),
  })
  .openapi("SubjectQuery");

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

export const courseSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    subject_id: uuidSchema.openapi({ description: "Parent subject." }),
    code: z
      .string()
      .openapi({ description: "Short unique code within the school.", example: "CALC101" }),
    name: z.string().openapi({ description: "Human-readable name.", example: "Calculus I" }),
    description: z.string().nullable().openapi({ description: "Optional description." }),
    credit_hours: z.number().positive().openapi({
      description: "Academic credits used to weight term and cumulative GPA.",
      example: 3,
    }),
    status: catalogStatusSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Course");

export type Course = z.infer<typeof courseSchema>;

export const createCourseBodySchema = z
  .object({
    subject_id: uuidSchema.openapi({ description: "Parent subject." }),
    code: z
      .string()
      .min(1)
      .max(50)
      .openapi({ description: "Short unique code.", example: "CALC101" }),
    name: z
      .string()
      .min(1)
      .max(200)
      .openapi({ description: "Human-readable name.", example: "Calculus I" }),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .openapi({ description: "Optional description." }),
    credit_hours: z.number().positive().default(1).openapi({
      description: "Academic credits used to weight term and cumulative GPA.",
      example: 3,
    }),
    status: catalogStatusSchema.default("draft"),
  })
  .openapi("CreateCourseBody");

export type CreateCourseBody = z.infer<typeof createCourseBodySchema>;

export const updateCourseBodySchema = z
  .object({
    code: z.string().min(1).max(50).optional().openapi({ description: "Short unique code." }),
    name: z.string().min(1).max(200).optional().openapi({ description: "Human-readable name." }),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .openapi({ description: "Optional description." }),
    credit_hours: z.number().positive().optional().openapi({
      description: "Academic credits; immutable after a course has published grades.",
      example: 3,
    }),
    status: catalogStatusSchema.optional(),
  })
  .openapi("UpdateCourseBody");

export type UpdateCourseBody = z.infer<typeof updateCourseBodySchema>;

export const courseListSchema = z
  .object({
    courses: z.array(courseSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("CourseList");

export const courseQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    status: catalogStatusSchema.optional(),
  })
  .openapi("CourseQuery");

// ---------------------------------------------------------------------------
// Path params (subjects & courses)
// ---------------------------------------------------------------------------

export const subjectIdParamSchema = z
  .object({
    subjectId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "subjectId", in: "path" },
        description: "Subject UUID.",
      }),
  })
  .openapi("SubjectIdParam");

export const courseIdParamSchema = z
  .object({
    courseId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "courseId", in: "path" },
        description: "Course UUID.",
      }),
  })
  .openapi("CourseIdParam");

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const classStatusSchema = z
  .enum(["planned", "active", "completed", "cancelled"])
  .openapi({ description: "Lifecycle state of a class." });

export type ClassStatus = z.infer<typeof classStatusSchema>;

export const enrollmentStatusSchema = z
  .enum(["active", "waitlisted", "withdrawn", "completed", "cancelled"])
  .openapi({ description: "Lifecycle state of an enrollment." });

export type EnrollmentStatus = z.infer<typeof enrollmentStatusSchema>;

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export const classSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    course_id: uuidSchema.openapi({ description: "Parent course." }),
    academic_year_id: uuidSchema.openapi({ description: "Parent academic year." }),
    term_id: uuidSchema.openapi({ description: "Parent term." }),
    lead_teacher_id: uuidSchema.openapi({ description: "Lead teacher." }),
    room_id: uuidSchema.openapi({ description: "Assigned room." }),
    code: z
      .string()
      .openapi({ description: "Short unique code within the school.", example: "CLASS-MATH-101" }),
    capacity: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Maximum enrollment count, or null for unlimited." }),
    status: classStatusSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Class");

export type Class = z.infer<typeof classSchema>;

export const createClassBodySchema = z
  .object({
    course_id: uuidSchema.openapi({ description: "Parent course." }),
    academic_year_id: uuidSchema.openapi({ description: "Parent academic year." }),
    term_id: uuidSchema.openapi({ description: "Parent term." }),
    lead_teacher_id: uuidSchema.openapi({ description: "Lead teacher." }),
    room_id: uuidSchema.openapi({ description: "Assigned room." }),
    code: z
      .string()
      .min(1)
      .max(50)
      .openapi({ description: "Short unique code.", example: "CLASS-MATH-101" }),
    capacity: z
      .number()
      .int()
      .min(1)
      .nullable()
      .optional()
      .openapi({ description: "Maximum enrollment count, or null for unlimited." }),
    status: classStatusSchema.default("planned"),
  })
  .openapi("CreateClassBody");

export type CreateClassBody = z.infer<typeof createClassBodySchema>;

export const updateClassBodySchema = z
  .object({
    lead_teacher_id: uuidSchema.optional().openapi({ description: "Lead teacher." }),
    room_id: uuidSchema.optional().openapi({ description: "Assigned room." }),
    code: z.string().min(1).max(50).optional().openapi({ description: "Short unique code." }),
    capacity: z
      .number()
      .int()
      .min(1)
      .nullable()
      .optional()
      .openapi({ description: "Maximum enrollment count, or null for unlimited." }),
    status: classStatusSchema.optional(),
  })
  .openapi("UpdateClassBody");

export type UpdateClassBody = z.infer<typeof updateClassBodySchema>;

export const classListSchema = z
  .object({
    classes: z.array(classSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("ClassList");

export const classQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    status: classStatusSchema.optional(),
    course_id: uuidSchema.optional(),
    term_id: uuidSchema.optional(),
    lead_teacher_id: uuidSchema.optional(),
  })
  .openapi("ClassQuery");

// ---------------------------------------------------------------------------
// Path params (classes & enrollments)
// ---------------------------------------------------------------------------

export const classIdParamSchema = z
  .object({
    classId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "classId", in: "path" },
        description: "Class UUID.",
      }),
  })
  .openapi("ClassIdParam");

// ---------------------------------------------------------------------------
// Enrollments
// ---------------------------------------------------------------------------

export const enrollmentSchema = z
  .object({
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    class_id: uuidSchema.openapi({ description: "Parent class." }),
    student_id: uuidSchema.openapi({ description: "Enrolled student." }),
    status: enrollmentStatusSchema,
    enrolled_at: dateTimeSchema,
    withdrawn_at: dateTimeSchema.nullable().openapi({ description: "When the student withdrew." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Enrollment");

export type Enrollment = z.infer<typeof enrollmentSchema>;

export const enrollmentListSchema = z
  .object({
    enrollments: z.array(enrollmentSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("EnrollmentList");

export const enrollmentQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    status: enrollmentStatusSchema.optional(),
  })
  .openapi("EnrollmentQuery");

export const createEnrollmentBodySchema = z
  .object({
    student_id: uuidSchema.openapi({ description: "Student to enroll." }),
  })
  .openapi("CreateEnrollmentBody");

export type CreateEnrollmentBody = z.infer<typeof createEnrollmentBodySchema>;

export const transferEnrollmentBodySchema = z
  .object({
    student_id: uuidSchema.openapi({ description: "Student to transfer." }),
    to_class_id: uuidSchema.openapi({ description: "Destination class." }),
  })
  .openapi("TransferEnrollmentBody");

export type TransferEnrollmentBody = z.infer<typeof transferEnrollmentBodySchema>;

export const studentIdParamSchema = z
  .object({
    studentId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "studentId", in: "path" },
        description: "Student UUID.",
      }),
  })
  .openapi("StudentIdParam");

// ---------------------------------------------------------------------------
// Timetable
// ---------------------------------------------------------------------------

export const timetableVersionStatusSchema = z
  .enum(["draft", "pending", "approved"])
  .openapi({ description: "Lifecycle state of a timetable version." });

export type TimetableVersionStatus = z.infer<typeof timetableVersionStatusSchema>;

export const timetableVersionSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    academic_year_id: uuidSchema.openapi({ description: "Parent academic year." }),
    term_id: uuidSchema.openapi({ description: "Parent term." }),
    name: z
      .string()
      .openapi({ description: "Human-readable name.", example: "Term 1 Weekly Schedule" }),
    status: timetableVersionStatusSchema,
    submitted_at: dateTimeSchema.nullable().openapi({ description: "When submitted for review." }),
    submitted_by_user_id: uuidSchema.nullable().openapi({ description: "Who submitted." }),
    approved_at: dateTimeSchema.nullable().openapi({ description: "When approved." }),
    approved_by_user_id: uuidSchema.nullable().openapi({ description: "Who approved." }),
    rejected_reason: z
      .string()
      .nullable()
      .openapi({ description: "Rejection reason, set when rejected back to draft." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("TimetableVersion");

export type TimetableVersion = z.infer<typeof timetableVersionSchema>;

export const createTimetableVersionBodySchema = z
  .object({
    term_id: uuidSchema.openapi({ description: "Target term." }),
    academic_year_id: uuidSchema.openapi({ description: "Parent academic year." }),
    name: z
      .string()
      .min(1)
      .max(200)
      .openapi({ description: "Human-readable name.", example: "Term 1 Weekly Schedule" }),
  })
  .openapi("CreateTimetableVersionBody");

export type CreateTimetableVersionBody = z.infer<typeof createTimetableVersionBodySchema>;

export const updateTimetableVersionBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional().openapi({ description: "Human-readable name." }),
  })
  .openapi("UpdateTimetableVersionBody");

export type UpdateTimetableVersionBody = z.infer<typeof updateTimetableVersionBodySchema>;

export const timetableVersionListSchema = z
  .object({
    timetable_versions: z.array(timetableVersionSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("TimetableVersionList");

export const timetableVersionQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    term_id: uuidSchema.openapi({ description: "Filter by term." }),
    status: timetableVersionStatusSchema.optional(),
  })
  .openapi("TimetableVersionQuery");

// ---------------------------------------------------------------------------
// Timetable Slots
// ---------------------------------------------------------------------------

export const timetableSlotSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    timetable_version_id: uuidSchema.openapi({ description: "Parent timetable version." }),
    class_id: uuidSchema.openapi({ description: "Scheduled class." }),
    teacher_id: uuidSchema.openapi({ description: "Assigned teacher." }),
    room_id: uuidSchema.openapi({ description: "Assigned room." }),
    weekday: z
      .number()
      .int()
      .min(1)
      .max(7)
      .openapi({ description: "Day of week (1=Mon, 7=Sun).", example: 1 }),
    period: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "Period number (1-based).", example: 2 }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("TimetableSlot");

export type TimetableSlot = z.infer<typeof timetableSlotSchema>;

export const createTimetableSlotBodySchema = z
  .object({
    class_id: uuidSchema.openapi({ description: "Class to schedule." }),
    teacher_id: uuidSchema.openapi({ description: "Teacher to assign." }),
    room_id: uuidSchema.openapi({ description: "Room to assign." }),
    weekday: z
      .number()
      .int()
      .min(1)
      .max(7)
      .openapi({ description: "Day of week (1=Mon, 7=Sun).", example: 1 }),
    period: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "Period number (1-based).", example: 2 }),
  })
  .openapi("CreateTimetableSlotBody");

export type CreateTimetableSlotBody = z.infer<typeof createTimetableSlotBodySchema>;

export const updateTimetableSlotBodySchema = z
  .object({
    class_id: uuidSchema.optional().openapi({ description: "Class to schedule." }),
    teacher_id: uuidSchema.optional().openapi({ description: "Teacher to assign." }),
    room_id: uuidSchema.optional().openapi({ description: "Room to assign." }),
    weekday: z
      .number()
      .int()
      .min(1)
      .max(7)
      .optional()
      .openapi({ description: "Day of week (1=Mon, 7=Sun)." }),
    period: z.number().int().min(1).optional().openapi({ description: "Period number (1-based)." }),
  })
  .openapi("UpdateTimetableSlotBody");

export type UpdateTimetableSlotBody = z.infer<typeof updateTimetableSlotBodySchema>;

export const timetableSlotListSchema = z
  .object({
    timetable_slots: z.array(timetableSlotSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("TimetableSlotList");

export const timetableSlotQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("TimetableSlotQuery");

// ---------------------------------------------------------------------------
// Timetable: Copy from previous term
// ---------------------------------------------------------------------------

export const copyTimetableBodySchema = z
  .object({
    source_version_id: uuidSchema.openapi({ description: "Version to copy slots from." }),
    name: z.string().min(1).max(200).openapi({
      description: "Name for the new draft version.",
      example: "Term 2 Weekly Schedule",
    }),
    term_id: uuidSchema.openapi({ description: "Target term." }),
    academic_year_id: uuidSchema.openapi({ description: "Target academic year." }),
  })
  .openapi("CopyTimetableBody");

export type CopyTimetableBody = z.infer<typeof copyTimetableBodySchema>;

export const copyTimetableResponseSchema = z
  .object({
    timetable_version: timetableVersionSchema,
    slots_copied: z.number().int().openapi({ description: "Number of slots successfully copied." }),
    slots_skipped: z
      .number()
      .int()
      .openapi({ description: "Number of slots skipped (class not in target term)." }),
  })
  .openapi("CopyTimetableResponse");

// ---------------------------------------------------------------------------
// Timetable: Reject body
// ---------------------------------------------------------------------------

export const rejectTimetableBodySchema = z
  .object({
    reason: z.string().min(1).max(2000).optional().openapi({
      description: "Rejection reason explaining why the version is sent back to draft.",
    }),
  })
  .openapi("RejectTimetableBody");

export type RejectTimetableBody = z.infer<typeof rejectTimetableBodySchema>;

// ---------------------------------------------------------------------------
// Timetable: Conflict payload (extension of ProblemDetails for 409)
// ---------------------------------------------------------------------------

export const timetableConflictDetailSchema = z
  .object({
    conflict_type: z
      .enum(["teacher", "room"])
      .openapi({ description: "What resource is double-booked." }),
    existing_slot_id: uuidSchema.openapi({ description: "ID of the conflicting slot." }),
    existing_class_code: z.string().openapi({ description: "Class code of the existing booking." }),
    entity_id: uuidSchema.openapi({ description: "Teacher or room ID that conflicts." }),
    entity_name: z
      .string()
      .openapi({ description: "Display name of the conflicting teacher or room." }),
    weekday: z.number().int().min(1).max(7).openapi({ description: "Day of week." }),
    period: z.number().int().min(1).openapi({ description: "Period number." }),
  })
  .openapi("TimetableConflictDetail");

// ---------------------------------------------------------------------------
// Path params (timetable)
// ---------------------------------------------------------------------------

export const versionIdParamSchema = z
  .object({
    versionId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "versionId", in: "path" },
        description: "Timetable version UUID.",
      }),
  })
  .openapi("VersionIdParam");

export const slotIdParamSchema = z
  .object({
    slotId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "slotId", in: "path" },
        description: "Timetable slot UUID.",
      }),
  })
  .openapi("SlotIdParam");

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

export const examStatusSchema = z
  .enum(["draft", "scheduled", "open", "closed", "cancelled", "archived"])
  .openapi({ description: "Lifecycle state of an exam." });

export type ExamStatus = z.infer<typeof examStatusSchema>;

export const examSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    class_id: uuidSchema.openapi({ description: "Parent class." }),
    created_by_user_id: uuidSchema.openapi({ description: "User who created the exam." }),
    last_edited_by_user_id: uuidSchema.openapi({ description: "User who last edited the exam." }),
    title: z.string().openapi({ description: "Exam title.", example: "Midterm Mathematics" }),
    description: z
      .string()
      .nullable()
      .openapi({ description: "Optional description.", example: "Covers chapters 1-5" }),
    status: examStatusSchema,
    starts_at: dateTimeSchema.openapi({ description: "Exam start timestamp." }),
    ends_at: dateTimeSchema.openapi({ description: "Exam end timestamp." }),
    max_score: z.number().openapi({ description: "Maximum possible score.", example: 100 }),
    room_id: uuidSchema
      .nullable()
      .openapi({ description: "Assigned room, or null if unassigned." }),
    weight: z.number().openapi({ description: "Weight in gradebook calculation.", example: 1 }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Exam");

export type Exam = z.infer<typeof examSchema>;

export const createExamBodySchema = z
  .object({
    class_id: uuidSchema.openapi({ description: "Parent class." }),
    title: z
      .string()
      .min(1)
      .max(200)
      .openapi({ description: "Exam title.", example: "Midterm Mathematics" }),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .openapi({ description: "Optional description." }),
    starts_at: z.string().datetime().openapi({ description: "Exam start (ISO 8601)." }),
    ends_at: z
      .string()
      .datetime()
      .openapi({ description: "Exam end (ISO 8601). Must be after starts_at." }),
    max_score: z
      .number()
      .positive()
      .openapi({ description: "Maximum possible score.", example: 100 }),
    room_id: uuidSchema
      .nullable()
      .optional()
      .openapi({ description: "Assigned room, or null to leave unassigned." }),
    weight: z
      .number()
      .positive()
      .default(1)
      .openapi({ description: "Weight in gradebook calculation.", example: 1 }),
    status: examStatusSchema.default("draft"),
  })
  .openapi("CreateExamBody");

export type CreateExamBody = z.infer<typeof createExamBodySchema>;

export const updateExamBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional().openapi({ description: "Exam title." }),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .openapi({ description: "Optional description." }),
    starts_at: z.string().datetime().optional().openapi({ description: "Exam start (ISO 8601)." }),
    ends_at: z.string().datetime().optional().openapi({ description: "Exam end (ISO 8601)." }),
    max_score: z.number().positive().optional().openapi({ description: "Maximum possible score." }),
    room_id: uuidSchema
      .nullable()
      .optional()
      .openapi({ description: "Assigned room, or null to clear." }),
    weight: z.number().positive().optional().openapi({ description: "Gradebook weight." }),
    status: examStatusSchema.optional(),
  })
  .openapi("UpdateExamBody");

export type UpdateExamBody = z.infer<typeof updateExamBodySchema>;

export const examListSchema = z
  .object({
    exams: z.array(examSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("ExamList");

export const examQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    class_id: uuidSchema.openapi({ description: "Filter by class." }),
    status: examStatusSchema.optional(),
  })
  .openapi("ExamQuery");

// ---------------------------------------------------------------------------
// Exam: conflict warnings (timetable overlap)
// ---------------------------------------------------------------------------

export const examConflictWarningSchema = z
  .object({
    conflict_type: z
      .enum(["class_slot", "room"])
      .openapi({ description: "What resource overlaps the exam schedule." }),
    timetable_slot_id: uuidSchema.openapi({ description: "Conflicting timetable slot ID." }),
    class_code: z
      .string()
      .openapi({ description: "Class code of the conflicting timetable slot." }),
    entity_id: uuidSchema.openapi({ description: "Class or room ID involved." }),
    entity_name: z.string().openapi({ description: "Display name of the conflicting entity." }),
    weekday: z.number().int().min(1).max(7).openapi({ description: "Day of week (1=Mon, 7=Sun)." }),
  })
  .openapi("ExamConflictWarning");

// ---------------------------------------------------------------------------
// Exam: composite response (exam + warnings)
// ---------------------------------------------------------------------------

export const examWithWarningsSchema = z
  .object({
    exam: examSchema,
    warnings: z.array(examConflictWarningSchema),
  })
  .openapi("ExamWithWarnings");

// ---------------------------------------------------------------------------
// Path params (exams)
// ---------------------------------------------------------------------------

export const examIdParamSchema = z
  .object({
    examId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "examId", in: "path" },
        description: "Exam UUID.",
      }),
  })
  .openapi("ExamIdParam");

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export const materialIngestStatusSchema = z
  .enum(["uploaded", "queued", "processing", "scanning", "ready", "failed", "quarantined"])
  .openapi({ description: "Ingestion lifecycle state of a material." });

export type MaterialIngestStatus = z.infer<typeof materialIngestStatusSchema>;

export const materialSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    class_id: uuidSchema.openapi({ description: "Parent class." }),
    uploaded_by_user_id: uuidSchema.openapi({ description: "User who uploaded." }),
    last_edited_by_user_id: uuidSchema.openapi({ description: "User who last edited." }),
    title: z
      .string()
      .openapi({ description: "Material title.", example: "Photosynthesis Study Guide" }),
    description: z.string().nullable().openapi({ description: "Optional description." }),
    storage_key: z.string().openapi({
      description: "Permanent object storage key.",
      example: "permanent/{schoolId}/materials/guide.pdf",
    }),
    original_file_name: z.string().openapi({
      description: "Original file name as uploaded.",
      example: "photosynthesis-guide.pdf",
    }),
    mime_type: z.string().openapi({ description: "MIME type.", example: "application/pdf" }),
    size_bytes: z.number().int().openapi({ description: "File size in bytes.", example: 204800 }),
    checksum_sha256: z
      .string()
      .nullable()
      .openapi({ description: "SHA-256 hex digest, or null if not computed." }),
    ai_visible: z
      .boolean()
      .openapi({ description: "Whether this material is exposed to AI ingestion." }),
    ingest_status: materialIngestStatusSchema,
    ingest_error: z
      .string()
      .nullable()
      .openapi({ description: "Last ingestion error message, or null." }),
    ingested_at: dateTimeSchema
      .nullable()
      .openapi({ description: "When ingestion last completed successfully." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Material");

export type Material = z.infer<typeof materialSchema>;

export const createMaterialBodySchema = z
  .object({
    class_id: uuidSchema.openapi({ description: "Parent class." }),
    title: z
      .string()
      .min(1)
      .max(200)
      .openapi({ description: "Material title.", example: "Photosynthesis Study Guide" }),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .openapi({ description: "Optional description." }),
    original_file_name: z
      .string()
      .min(1)
      .max(255)
      .openapi({ description: "Original file name.", example: "photosynthesis-guide.pdf" }),
    mime_type: z
      .string()
      .min(1)
      .max(127)
      .openapi({ description: "MIME type.", example: "application/pdf" }),
    size_bytes: z.number().int().min(1).openapi({ description: "File size in bytes." }),
    checksum_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .openapi({ description: "SHA-256 hex digest." }),
  })
  .openapi("CreateMaterialBody");

export type CreateMaterialBody = z.infer<typeof createMaterialBodySchema>;

export const updateMaterialBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional().openapi({ description: "Material title." }),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .openapi({ description: "Optional description." }),
  })
  .openapi("UpdateMaterialBody");

export type UpdateMaterialBody = z.infer<typeof updateMaterialBodySchema>;

export const materialListSchema = z
  .object({
    materials: z.array(materialSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("MaterialList");

export const materialQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    class_id: uuidSchema.optional(),
    ingest_status: materialIngestStatusSchema.optional(),
  })
  .openapi("MaterialQuery");

export const materialIdParamSchema = z
  .object({
    materialId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "materialId", in: "path" },
        description: "Material UUID.",
      }),
  })
  .openapi("MaterialIdParam");

// ---------------------------------------------------------------------------
// Materials — presigned upload flow
// ---------------------------------------------------------------------------

export const presignedUploadResponseSchema = z
  .object({
    upload_url: z.string().url().openapi({ description: "Pre-signed URL for PUT upload." }),
    storage_key: z.string().openapi({ description: "Storage key the file will be written to." }),
    expires_at: dateTimeSchema.openapi({ description: "When the upload URL expires." }),
  })
  .openapi("PresignedUpload");

export const confirmUploadBodySchema = z
  .object({
    storage_key: z
      .string()
      .min(1)
      .openapi({ description: "Storage key returned by the presign step." }),
    checksum_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .openapi({ description: "Client-computed SHA-256 hex digest." }),
  })
  .openapi("ConfirmUploadBody");

export type ConfirmUploadBody = z.infer<typeof confirmUploadBodySchema>;

export const toggleAiVisibleBodySchema = z
  .object({
    ai_visible: z.boolean().openapi({ description: "New AI visibility setting." }),
  })
  .openapi("ToggleAiVisibleBody");

export type ToggleAiVisibleBody = z.infer<typeof toggleAiVisibleBodySchema>;
