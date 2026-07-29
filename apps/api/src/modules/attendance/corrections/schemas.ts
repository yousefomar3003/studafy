import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

import { attendanceStatusSchema } from "../schemas";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export const recordIdParamSchema = z
  .object({
    recordId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "recordId", in: "path" },
        description: "Attendance record UUID.",
      }),
  })
  .openapi("RecordIdParam");

// ---------------------------------------------------------------------------
// Correction request
// ---------------------------------------------------------------------------

export const correctAttendanceRecordBodySchema = z
  .object({
    status: attendanceStatusSchema.openapi({
      description: "Corrected attendance status. Must differ from the current state.",
    }),
    minutes_late: z.number().int().positive().nullable().optional().openapi({
      description:
        "Minutes late. Required when status is 'late'; ignored and stored as null otherwise.",
    }),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .openapi({ description: "Mandatory justification recorded on the version chain." }),
  })
  .openapi("CorrectAttendanceRecordBody");

export type CorrectAttendanceRecordBody = z.infer<typeof correctAttendanceRecordBodySchema>;

// ---------------------------------------------------------------------------
// Correction response
// ---------------------------------------------------------------------------

/**
 * The corrected record.
 *
 * Deliberately not `attendanceRecordSchema`: that schema describes a record as first written and
 * exposes neither `version` nor `updated_at`, both of which are the entire point of a correction
 * response. Extending rather than widening the original keeps the batch-record contract unchanged.
 */
export const correctedAttendanceRecordSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    attendance_session_id: uuidSchema.openapi({ description: "Parent attendance session." }),
    student_id: uuidSchema.openapi({ description: "Student this record belongs to." }),
    status: attendanceStatusSchema,
    minutes_late: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .openapi({ description: "Minutes late; non-null only when status is 'late'." }),
    reason: z
      .string()
      .nullable()
      .openapi({ description: "Reason carried on the record itself, if any." }),
    recorded_by_user_id: uuidSchema
      .nullable()
      .openapi({ description: "User who first recorded this entry." }),
    version: z
      .number()
      .int()
      .positive()
      .openapi({ description: "Correction generation after this call. 1 means never corrected." }),
    out_of_window: z.boolean().openapi({
      description: "True when this correction was an administrative override past the window.",
    }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("CorrectedAttendanceRecord");

export type CorrectedAttendanceRecord = z.infer<typeof correctedAttendanceRecordSchema>;

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export const attendanceRecordHistoryEntrySchema = z
  .object({
    version: z
      .number()
      .int()
      .positive()
      .openapi({ description: "Generation number. 1 is the record as first submitted." }),
    status: attendanceStatusSchema.openapi({ description: "Status as of this generation." }),
    previous_status: attendanceStatusSchema
      .nullable()
      .openapi({ description: "Status this generation replaced. Null on generation 1." }),
    minutes_late: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .openapi({ description: "Minutes late as of this generation." }),
    reason: z
      .string()
      .nullable()
      .openapi({ description: "Correction justification. Null on generation 1." }),
    corrected_by_user_id: uuidSchema
      .nullable()
      .openapi({ description: "Acting user. On generation 1, whoever first recorded the entry." }),
    corrected_at: dateTimeSchema.openapi({
      description: "When this generation was written. On generation 1, the record's creation time.",
    }),
    out_of_window: z.boolean().openapi({
      description: "True when written as an out-of-window administrative override.",
    }),
  })
  .openapi("AttendanceRecordHistoryEntry");

export type AttendanceRecordHistoryEntry = z.infer<typeof attendanceRecordHistoryEntrySchema>;

export const attendanceRecordHistorySchema = z
  .object({
    record_id: uuidSchema.openapi({ description: "The record this chain belongs to." }),
    student_id: uuidSchema.openapi({ description: "Student the record covers." }),
    attendance_session_id: uuidSchema.openapi({ description: "Parent attendance session." }),
    entries: z
      .array(attendanceRecordHistoryEntrySchema)
      .openapi({ description: "Full chain in ascending version order, starting at generation 1." }),
  })
  .openapi("AttendanceRecordHistory");

export type AttendanceRecordHistory = z.infer<typeof attendanceRecordHistorySchema>;
