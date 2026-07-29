import type { ReportExportFormat, ReportExportStatus } from "@studafy/attendance-reporting";
import type { TransactionSql } from "postgres";

export interface ReportExportJobRow {
  id: string;
  school_id: string;
  requested_by_user_id: string;
  report_type: "attendance_summary";
  file_format: ReportExportFormat;
  status: ReportExportStatus;
  storage_key: string | null;
  error_message: string | null;
  created_at: Date;
  completed_at: Date | null;
}

const JOB_COLUMNS = `
  id, school_id, requested_by_user_id, report_type::text AS report_type,
  file_format::text AS file_format, status::text AS status, storage_key,
  error_message, created_at, completed_at
`;

function parseJob(row: Record<string, unknown>): ReportExportJobRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    requested_by_user_id: row.requested_by_user_id as string,
    report_type: row.report_type as "attendance_summary",
    file_format: row.file_format as ReportExportFormat,
    status: row.status as ReportExportStatus,
    storage_key: row.storage_key as string | null,
    error_message: row.error_message as string | null,
    created_at: row.created_at as Date,
    completed_at: row.completed_at as Date | null,
  };
}

export async function createReportExportJob(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  fileFormat: ReportExportFormat,
): Promise<ReportExportJobRow> {
  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.report_export_jobs
      (school_id, requested_by_user_id, report_type, file_format)
    VALUES
      (${schoolId}, ${userId}, 'attendance_summary', ${fileFormat}::app.report_export_format)
    RETURNING ${tx.unsafe(JOB_COLUMNS)}
  `;
  if (!row) throw new Error("report export job insert returned no row");
  return parseJob(row);
}

export async function failReportExportJob(
  tx: TransactionSql,
  schoolId: string,
  jobId: string,
  message: string,
): Promise<void> {
  await tx`
    UPDATE app.report_export_jobs
    SET status = 'failed',
        error_message = ${message.slice(0, 1000)},
        storage_key = NULL,
        completed_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId} AND id = ${jobId}
      AND status IN ('pending', 'processing')
  `;
}

export async function getReportExportJob(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  jobId: string,
): Promise<ReportExportJobRow | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(JOB_COLUMNS)}
    FROM app.report_export_jobs
    WHERE school_id = ${schoolId}
      AND requested_by_user_id = ${userId}
      AND id = ${jobId}
  `;
  return row ? parseJob(row) : undefined;
}
