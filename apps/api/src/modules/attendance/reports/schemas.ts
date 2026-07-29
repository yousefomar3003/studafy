import { z } from "@hono/zod-openapi";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

const scopeFields = {
  term_id: uuidSchema.optional().openapi({ description: "Term whose inclusive dates are used." }),
  start_date: z.string().date().optional().openapi({ description: "Inclusive first date." }),
  end_date: z.string().date().optional().openapi({ description: "Inclusive last date." }),
  class_id: uuidSchema.optional().openapi({ description: "Optional class filter." }),
  student_id: uuidSchema.optional().openapi({ description: "Optional student filter." }),
};

function validateScope(
  value: { term_id?: string; start_date?: string; end_date?: string },
  context: z.core.ParsePayload<unknown>,
): void {
  const hasTerm = value.term_id !== undefined;
  const hasStart = value.start_date !== undefined;
  const hasEnd = value.end_date !== undefined;
  if (hasTerm === (hasStart || hasEnd)) {
    context.issues.push({
      code: "custom",
      input: value,
      message: "Provide either term_id or start_date and end_date, but not both.",
    });
    return;
  }
  if (!hasTerm && (!hasStart || !hasEnd)) {
    context.issues.push({
      code: "custom",
      input: value,
      message: "Both start_date and end_date are required.",
    });
    return;
  }
  if (hasStart && hasEnd) {
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
  }
}

export const reportGroupBySchema = z.enum(["class", "student"]);
export const reportTrendIntervalSchema = z.enum(["day", "week", "month"]);
export const reportExportFormatSchema = z.enum(["xlsx", "pdf"]);
export const reportExportStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);

export const attendanceSummaryQuerySchema = z
  .object({
    ...scopeFields,
    group_by: reportGroupBySchema.default("class"),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .superRefine(validateScope)
  .openapi("AttendanceReportSummaryQuery");

export const attendanceTrendsQuerySchema = z
  .object({
    ...scopeFields,
    interval: reportTrendIntervalSchema.default("day"),
  })
  .superRefine(validateScope)
  .openapi("AttendanceReportTrendsQuery");

export const attendanceExportBodySchema = z
  .object({
    ...scopeFields,
    file_format: reportExportFormatSchema,
    group_by: reportGroupBySchema.default("class"),
    trend_interval: reportTrendIntervalSchema.default("day"),
  })
  .superRefine(validateScope)
  .openapi("AttendanceReportExportBody");

export const exportJobIdParamSchema = z
  .object({
    jobId: uuidSchema.openapi({
      param: { name: "jobId", in: "path" },
      description: "Report export job UUID.",
    }),
  })
  .openapi("AttendanceReportExportJobIdParam");

export const reportPeriodSchema = z
  .object({
    term_id: uuidSchema.nullable(),
    start_date: dateSchema,
    end_date: dateSchema,
  })
  .openapi("AttendanceReportPeriod");

export const attendanceMetricsSchema = z
  .object({
    total_records: z.number().int().nonnegative(),
    present_count: z.number().int().nonnegative(),
    absent_count: z.number().int().nonnegative(),
    late_count: z.number().int().nonnegative(),
    excused_count: z.number().int().nonnegative(),
    present_percent: z.number().min(0).max(100),
    absent_percent: z.number().min(0).max(100),
    late_percent: z.number().min(0).max(100),
    excused_percent: z.number().min(0).max(100),
  })
  .openapi("AttendanceReportMetrics");

const classSummaryItemSchema = attendanceMetricsSchema
  .extend({
    group_by: z.literal("class"),
    class_id: uuidSchema,
    class_code: z.string(),
  })
  .openapi("AttendanceReportClassSummaryItem");

const studentSummaryItemSchema = attendanceMetricsSchema
  .extend({
    group_by: z.literal("student"),
    student_id: uuidSchema,
    student_name: z.string(),
    admission_number: z.string(),
  })
  .openapi("AttendanceReportStudentSummaryItem");

export const attendanceSummaryResponseSchema = z
  .object({
    generated_at: dateTimeSchema,
    period: reportPeriodSchema,
    group_by: reportGroupBySchema,
    totals: attendanceMetricsSchema,
    items: z.array(
      z.discriminatedUnion("group_by", [classSummaryItemSchema, studentSummaryItemSchema]),
    ),
    pagination: z.object({
      limit: z.number().int(),
      offset: z.number().int(),
      total: z.number().int(),
    }),
  })
  .openapi("AttendanceReportSummary");

export const attendanceTrendPointSchema = attendanceMetricsSchema
  .extend({ bucket_start: dateSchema })
  .openapi("AttendanceReportTrendPoint");

export const attendanceTrendsResponseSchema = z
  .object({
    generated_at: dateTimeSchema,
    period: reportPeriodSchema,
    interval: reportTrendIntervalSchema,
    points: z.array(attendanceTrendPointSchema),
  })
  .openapi("AttendanceReportTrends");

export const reportExportJobSchema = z
  .object({
    id: uuidSchema,
    report_type: z.literal("attendance_summary"),
    file_format: reportExportFormatSchema,
    status: reportExportStatusSchema,
    created_at: dateTimeSchema,
    completed_at: dateTimeSchema.nullable(),
    download_url: z.string().url().nullable(),
    download_url_expires_at: dateTimeSchema.nullable(),
    failure_message: z.string().nullable(),
  })
  .openapi("AttendanceReportExportJob");
