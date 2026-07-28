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
