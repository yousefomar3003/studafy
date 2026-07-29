import { z } from "zod";

import type { PendingQuery, TransactionSql } from "postgres";

export type ReportGroupBy = "class" | "student";
export type ReportTrendInterval = "day" | "week" | "month";
export type ReportExportFormat = "xlsx" | "pdf";
export type ReportExportStatus = "pending" | "processing" | "completed" | "failed";

export interface ReportFilterInput {
  termId?: string;
  startDate?: string;
  endDate?: string;
  classId?: string;
  studentId?: string;
}

export interface ResolvedReportFilter {
  termId: string | null;
  startDate: string;
  endDate: string;
  classId?: string;
  studentId?: string;
}

export interface AttendanceMetrics {
  total_records: number;
  present_count: number;
  absent_count: number;
  late_count: number;
  excused_count: number;
  present_percent: number;
  absent_percent: number;
  late_percent: number;
  excused_percent: number;
}

export interface ClassSummaryItem extends AttendanceMetrics {
  group_by: "class";
  class_id: string;
  class_code: string;
}

export interface StudentSummaryItem extends AttendanceMetrics {
  group_by: "student";
  student_id: string;
  student_name: string;
  admission_number: string;
}

export type AttendanceSummaryItem = ClassSummaryItem | StudentSummaryItem;

export interface AttendanceSummaryResult {
  totals: AttendanceMetrics;
  items: AttendanceSummaryItem[];
  total_groups: number;
}

export interface AttendanceTrendPoint extends AttendanceMetrics {
  bucket_start: string;
}

export class ReportResourceNotFoundError extends Error {
  constructor(resource: "term" | "class" | "student") {
    super(`${resource} not found`);
    this.name = "ReportResourceNotFoundError";
  }
}

export class ReportFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportFilterError";
  }
}

const uuidSchema = z.string().uuid();
const dateSchema = z.string().date();

export const attendanceExportJobDataSchema = z
  .object({
    version: z.literal(1),
    jobId: uuidSchema,
    schoolId: uuidSchema,
    requestedByUserId: uuidSchema,
    filter: z.object({
      termId: uuidSchema.nullable(),
      startDate: dateSchema,
      endDate: dateSchema,
      classId: uuidSchema.optional(),
      studentId: uuidSchema.optional(),
    }),
    groupBy: z.enum(["class", "student"]),
    trendInterval: z.enum(["day", "week", "month"]),
    fileFormat: z.enum(["xlsx", "pdf"]),
  })
  .strict();

export type AttendanceExportJobData = z.infer<typeof attendanceExportJobDataSchema>;

const ZERO_METRICS: AttendanceMetrics = {
  total_records: 0,
  present_count: 0,
  absent_count: 0,
  late_count: 0,
  excused_count: 0,
  present_percent: 0,
  absent_percent: 0,
  late_percent: 0,
  excused_percent: 0,
};

function parseInteger(value: unknown): number {
  return Number(value ?? 0);
}

function parseDecimal(value: unknown): number {
  return Number(value ?? 0);
}

function parseMetrics(row: Record<string, unknown> | undefined): AttendanceMetrics {
  if (!row) return { ...ZERO_METRICS };
  return {
    total_records: parseInteger(row.total_records),
    present_count: parseInteger(row.present_count),
    absent_count: parseInteger(row.absent_count),
    late_count: parseInteger(row.late_count),
    excused_count: parseInteger(row.excused_count),
    present_percent: parseDecimal(row.present_percent),
    absent_percent: parseDecimal(row.absent_percent),
    late_percent: parseDecimal(row.late_percent),
    excused_percent: parseDecimal(row.excused_percent),
  };
}

function assertDateRange(startDate: string, endDate: string): void {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new ReportFilterError("end_date must be on or after start_date");
  }
  const inclusiveDays = Math.floor((end - start) / 86_400_000) + 1;
  if (inclusiveDays > 366) {
    throw new ReportFilterError("report date range must not exceed 366 days");
  }
}

export async function resolveReportFilter(
  tx: TransactionSql,
  schoolId: string,
  input: ReportFilterInput,
): Promise<ResolvedReportFilter> {
  let termId: string | null = null;
  let startDate: string;
  let endDate: string;

  if (input.termId) {
    const [term] = await tx<{ id: string; starts_on: string; ends_on: string }[]>`
      SELECT id, starts_on::text AS starts_on, ends_on::text AS ends_on
      FROM app.terms
      WHERE school_id = ${schoolId} AND id = ${input.termId}
    `;
    if (!term) throw new ReportResourceNotFoundError("term");
    termId = term.id;
    startDate = term.starts_on;
    endDate = term.ends_on;
  } else if (input.startDate && input.endDate) {
    startDate = input.startDate;
    endDate = input.endDate;
  } else {
    throw new ReportFilterError("provide term_id or both start_date and end_date");
  }

  assertDateRange(startDate, endDate);

  if (input.classId) {
    const [row] = await tx<{ id: string }[]>`
      SELECT id FROM app.classes
      WHERE school_id = ${schoolId} AND id = ${input.classId}
    `;
    if (!row) throw new ReportResourceNotFoundError("class");
  }

  if (input.studentId) {
    const [row] = await tx<{ id: string }[]>`
      SELECT id FROM app.students
      WHERE school_id = ${schoolId} AND id = ${input.studentId}
    `;
    if (!row) throw new ReportResourceNotFoundError("student");
  }

  return {
    termId,
    startDate,
    endDate,
    ...(input.classId ? { classId: input.classId } : {}),
    ...(input.studentId ? { studentId: input.studentId } : {}),
  };
}

function baseCte(tx: TransactionSql, schoolId: string, filter: ResolvedReportFilter) {
  const termFilter = filter.termId ? tx` AND cl.term_id = ${filter.termId}` : tx``;
  const classFilter = filter.classId ? tx` AND s.class_id = ${filter.classId}` : tx``;
  const studentFilter = filter.studentId ? tx` AND r.student_id = ${filter.studentId}` : tx``;

  return tx`
    SELECT
      s.class_id,
      cl.code AS class_code,
      r.student_id,
      st.admission_number,
      concat_ws(' ', st.first_name, st.middle_name, st.last_name) AS student_name,
      s.session_date,
      r.status::text AS attendance_status
    FROM app.attendance_sessions AS s
    JOIN app.classes AS cl
      ON cl.school_id = s.school_id AND cl.id = s.class_id
    JOIN app.attendance_records AS r
      ON r.school_id = s.school_id
     AND r.attendance_session_id = s.id
     AND r.session_created_at = s.created_at
    JOIN app.students AS st
      ON st.school_id = r.school_id AND st.id = r.student_id
    WHERE s.school_id = ${schoolId}
      AND s.session_date BETWEEN ${filter.startDate}::date AND ${filter.endDate}::date
      AND s.status IN ('submitted', 'locked')
      ${termFilter}
      ${classFilter}
      ${studentFilter}
  `;
}

const METRICS_SQL = `
  count(*)::int AS total_records,
  count(*) FILTER (WHERE attendance_status IN ('present', 'remote'))::int AS present_count,
  count(*) FILTER (WHERE attendance_status = 'absent')::int AS absent_count,
  count(*) FILTER (WHERE attendance_status = 'late')::int AS late_count,
  count(*) FILTER (WHERE attendance_status = 'excused')::int AS excused_count,
  CASE WHEN count(*) = 0 THEN 0
    ELSE round(100.0 * count(*) FILTER (WHERE attendance_status IN ('present', 'remote')) / count(*), 2)
  END AS present_percent,
  CASE WHEN count(*) = 0 THEN 0
    ELSE round(100.0 * count(*) FILTER (WHERE attendance_status = 'absent') / count(*), 2)
  END AS absent_percent,
  CASE WHEN count(*) = 0 THEN 0
    ELSE round(100.0 * count(*) FILTER (WHERE attendance_status = 'late') / count(*), 2)
  END AS late_percent,
  CASE WHEN count(*) = 0 THEN 0
    ELSE round(100.0 * count(*) FILTER (WHERE attendance_status = 'excused') / count(*), 2)
  END AS excused_percent
`;

function summaryQueries(
  tx: TransactionSql,
  schoolId: string,
  filter: ResolvedReportFilter,
  groupBy: ReportGroupBy,
  limit: number,
  offset: number,
): {
  rows: PendingQuery<Record<string, unknown>[]>;
  count: PendingQuery<{ count: number }[]>;
} {
  const base = baseCte(tx, schoolId, filter);
  if (groupBy === "class") {
    return {
      rows: tx<Record<string, unknown>[]>`
        WITH report_base AS (${base})
        SELECT class_id, class_code, ${tx.unsafe(METRICS_SQL)}
        FROM report_base
        GROUP BY class_id, class_code
        ORDER BY class_code, class_id
        LIMIT ${limit} OFFSET ${offset}
      `,
      count: tx<{ count: number }[]>`
        WITH report_base AS (${base})
        SELECT count(*)::int AS count
        FROM (SELECT class_id FROM report_base GROUP BY class_id) AS groups
      `,
    };
  }
  return {
    rows: tx<Record<string, unknown>[]>`
      WITH report_base AS (${base})
      SELECT student_id, student_name, admission_number, ${tx.unsafe(METRICS_SQL)}
      FROM report_base
      GROUP BY student_id, student_name, admission_number
      ORDER BY student_name, admission_number, student_id
      LIMIT ${limit} OFFSET ${offset}
    `,
    count: tx<{ count: number }[]>`
      WITH report_base AS (${base})
      SELECT count(*)::int AS count
      FROM (SELECT student_id FROM report_base GROUP BY student_id) AS groups
    `,
  };
}

export async function queryAttendanceSummary(
  tx: TransactionSql,
  schoolId: string,
  filter: ResolvedReportFilter,
  groupBy: ReportGroupBy,
  pagination: { limit: number; offset: number },
): Promise<AttendanceSummaryResult> {
  const base = baseCte(tx, schoolId, filter);
  const grouped = summaryQueries(
    tx,
    schoolId,
    filter,
    groupBy,
    pagination.limit,
    pagination.offset,
  );
  const totalsQuery = tx<Record<string, unknown>[]>`
    WITH report_base AS (${base})
    SELECT ${tx.unsafe(METRICS_SQL)}
    FROM report_base
  `;

  const [rows, countRows, totalRows] = await Promise.all([
    grouped.rows,
    grouped.count,
    totalsQuery,
  ]);

  const items: AttendanceSummaryItem[] = rows.map((row) => {
    const metrics = parseMetrics(row);
    if (groupBy === "class") {
      return {
        group_by: "class",
        class_id: String(row.class_id),
        class_code: String(row.class_code),
        ...metrics,
      };
    }
    return {
      group_by: "student",
      student_id: String(row.student_id),
      student_name: String(row.student_name),
      admission_number: String(row.admission_number),
      ...metrics,
    };
  });

  return {
    totals: parseMetrics(totalRows[0]),
    items,
    total_groups: Number(countRows[0]?.count ?? 0),
  };
}

export async function queryAttendanceTrends(
  tx: TransactionSql,
  schoolId: string,
  filter: ResolvedReportFilter,
  interval: ReportTrendInterval,
): Promise<AttendanceTrendPoint[]> {
  const base = baseCte(tx, schoolId, filter);
  const rows = await tx<Record<string, unknown>[]>`
    WITH report_base AS (${base})
    SELECT
      date_trunc(${interval}, session_date::timestamp)::date::text AS bucket_start,
      ${tx.unsafe(METRICS_SQL)}
    FROM report_base
    GROUP BY bucket_start
    ORDER BY bucket_start
  `;
  return rows.map((row) => ({
    bucket_start: String(row.bucket_start),
    ...parseMetrics(row),
  }));
}

export async function queryCompleteAttendanceReport(
  tx: TransactionSql,
  schoolId: string,
  filter: ResolvedReportFilter,
  groupBy: ReportGroupBy,
  trendInterval: ReportTrendInterval,
): Promise<{
  summary: AttendanceSummaryResult;
  trends: AttendanceTrendPoint[];
}> {
  const [summary, trends] = await Promise.all([
    queryAttendanceSummary(tx, schoolId, filter, groupBy, {
      limit: 100_000,
      offset: 0,
    }),
    queryAttendanceTrends(tx, schoolId, filter, trendInterval),
  ]);
  return { summary, trends };
}
