import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema, dateSchema } from "@studafy/shared-schemas";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const attendanceSessionStatusSchema = z
  .enum(["draft", "open", "submitted", "locked", "cancelled"])
  .openapi({ description: "Lifecycle state of an attendance session." });

export type AttendanceSessionStatus = z.infer<typeof attendanceSessionStatusSchema>;

// ---------------------------------------------------------------------------
// Attendance Session
// ---------------------------------------------------------------------------

export const attendanceSessionSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    class_id: uuidSchema.openapi({ description: "Parent class." }),
    session_date: dateSchema.openapi({ description: "Educational business date." }),
    period: z
      .number()
      .int()
      .positive()
      .nullable()
      .openapi({ description: "Timetable period (1-based), or null for daily attendance." }),
    status: attendanceSessionStatusSchema,
    taken_by_user_id: uuidSchema
      .nullable()
      .openapi({ description: "User who opened the session." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("AttendanceSession");

export type AttendanceSession = z.infer<typeof attendanceSessionSchema>;

export const createAttendanceSessionBodySchema = z
  .object({
    class_id: uuidSchema.openapi({ description: "Class to take attendance for." }),
    session_date: z
      .string()
      .date()
      .openapi({ description: "Educational business date (YYYY-MM-DD)." }),
    period: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: "Timetable period (1-based). Omit for daily attendance." }),
  })
  .openapi("CreateAttendanceSessionBody");

export type CreateAttendanceSessionBody = z.infer<typeof createAttendanceSessionBodySchema>;

export const updateAttendanceSessionBodySchema = z
  .object({
    status: attendanceSessionStatusSchema.openapi({ description: "New session status." }),
  })
  .openapi("UpdateAttendanceSessionBody");

export type UpdateAttendanceSessionBody = z.infer<typeof updateAttendanceSessionBodySchema>;

export const attendanceSessionListSchema = z
  .object({
    attendance_sessions: z.array(attendanceSessionSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("AttendanceSessionList");

export const attendanceSessionQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    class_id: uuidSchema.optional().openapi({ description: "Filter by class." }),
    session_date: z.string().date().optional().openapi({ description: "Filter by session date." }),
  })
  .openapi("AttendanceSessionQuery");

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const sessionIdParamSchema = z
  .object({
    sessionId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "sessionId", in: "path" },
        description: "Attendance session UUID.",
      }),
  })
  .openapi("SessionIdParam");

// ---------------------------------------------------------------------------
// Attendance Records
// ---------------------------------------------------------------------------

export const attendanceStatusSchema = z
  .enum(["present", "absent", "late", "excused", "remote"])
  .openapi({ description: "Attendance status for a single student record." });

export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;

export const attendanceRecordSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    attendance_session_id: uuidSchema.openapi({ description: "Parent attendance session." }),
    student_id: uuidSchema.openapi({ description: "Student this record belongs to." }),
    status: attendanceStatusSchema,
    minutes_late: z
      .number()
      .int()
      .positive()
      .nullable()
      .openapi({ description: "Minutes late; non-null only when status is 'late'." }),
    reason: z.string().nullable().openapi({ description: "Optional free-text reason." }),
    recorded_by_user_id: uuidSchema
      .nullable()
      .openapi({ description: "User who recorded this entry." }),
    created_at: dateTimeSchema,
  })
  .openapi("AttendanceRecord");

export type AttendanceRecord = z.infer<typeof attendanceRecordSchema>;

export const classIdParamSchema = z
  .object({
    classId: z
      .string()
      .uuid()
      .openapi({ param: { name: "classId", in: "path" } }),
  })
  .openapi("AttendanceClassIdParam");

export const attendanceRosterSchema = z
  .object({
    class_id: uuidSchema,
    students: z
      .array(
        z.object({
          id: uuidSchema,
          name: z.string().openapi({ description: "Preferred (else first) name and last name." }),
        }),
      )
      .openapi({ description: "Actively enrolled students, ordered by name." }),
  })
  .openapi("AttendanceRoster");

export const studentIdParamSchema = z
  .object({
    studentId: z
      .string()
      .uuid()
      .openapi({ param: { name: "studentId", in: "path" }, description: "Student UUID." }),
  })
  .openapi("AttendanceStudentIdParam");

export const studentAttendanceQuerySchema = z
  .object({
    start_date: dateSchema.openapi({ description: "First session date to include (inclusive)." }),
    end_date: dateSchema.openapi({ description: "Last session date to include (inclusive)." }),
  })
  .superRefine((value, context) => {
    const start = Date.parse(`${value.start_date}T00:00:00Z`);
    const end = Date.parse(`${value.end_date}T00:00:00Z`);
    const inclusiveDays = Math.floor((end - start) / 86_400_000) + 1;
    if (end < start || inclusiveDays > 366) {
      context.issues.push({
        code: "custom",
        input: value,
        message: "Date range must be ordered and no longer than 366 inclusive days.",
      });
    }
  })
  .openapi("StudentAttendanceQuery");

export const studentAttendanceEntrySchema = z
  .object({
    id: uuidSchema.openapi({ description: "Attendance record id." }),
    attendance_session_id: uuidSchema,
    session_date: dateSchema,
    period: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Period, or null for a daily register." }),
    class_id: uuidSchema,
    class_code: z.string(),
    status: attendanceStatusSchema,
    minutes_late: z.number().int().positive().nullable(),
    reason: z.string().nullable(),
  })
  .openapi("StudentAttendanceEntry");

export const studentAttendanceRecordsSchema = z
  .object({
    student_id: uuidSchema,
    records: z.array(studentAttendanceEntrySchema).openapi({
      description: "The student's records in the range, newest session first.",
    }),
  })
  .openapi("StudentAttendanceRecords");

export const attendanceSessionRecordsSchema = z
  .object({
    attendance_session_id: uuidSchema,
    records: z.array(attendanceRecordSchema).openapi({
      description: "Every record already taken in the session, ordered by student.",
    }),
  })
  .openapi("AttendanceSessionRecords");

export const batchRecordItemSchema = z
  .object({
    student_id: uuidSchema.openapi({ description: "Student to record attendance for." }),
    status: attendanceStatusSchema,
    minutes_late: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: "Required when status is 'late'." }),
    reason: z.string().max(500).optional().openapi({ description: "Optional reason text." }),
  })
  .openapi("BatchRecordItem");

export type BatchRecordItem = z.infer<typeof batchRecordItemSchema>;

export const batchRecordAttendanceBodySchema = z
  .object({
    attendance_session_id: uuidSchema.openapi({ description: "Target attendance session." }),
    records: z
      .array(batchRecordItemSchema)
      .min(1)
      .max(50)
      .openapi({ description: "Student attendance states (1–50 entries)." }),
  })
  .openapi("BatchRecordAttendanceBody");

export type BatchRecordAttendanceBody = z.infer<typeof batchRecordAttendanceBodySchema>;

export const batchRecordAttendanceResponseSchema = z
  .object({
    attendance_session_id: uuidSchema,
    records: z.array(attendanceRecordSchema),
    created_count: z
      .number()
      .int()
      .openapi({ description: "Number of records inserted in this call." }),
    total_count: z
      .number()
      .int()
      .openapi({ description: "Total records for this session after this call." }),
  })
  .openapi("BatchRecordAttendanceResponse");

export type BatchRecordAttendanceResponse = z.infer<typeof batchRecordAttendanceResponseSchema>;
