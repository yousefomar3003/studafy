/**
 * Attendance export report type (ST-175).
 *
 * After the async report framework landed, this file is the attendance half of a registry entry:
 * the deterministic storage key, the renderer (read the replica under the requester's role scope,
 * then render XLSX or PDF), and the content headers. The lifecycle SQL that used to live here
 * moved to `attendance-report-store.ts`, and `processAttendanceExport` was replaced by the generic
 * runner in `report-runner.ts`.
 */

import { queryCompleteAttendanceReport } from "@studafy/attendance-reporting";

import { withTenantTx } from "../../db/tenant-tx";

import { renderPdf, renderXlsx } from "./render";

import type { ReportRenderDeps } from "./report-types";
import type { AttendanceExportJobData } from "@studafy/attendance-reporting";

export { isFinalAttempt as isFinalExportAttempt } from "./report-runner";

export function attendanceReportStorageKey(data: AttendanceExportJobData): string {
  return `reports/${data.schoolId}/${data.jobId}/attendance-summary.${data.fileFormat}`;
}

export function attendanceContentType(data: AttendanceExportJobData): string {
  return data.fileFormat === "xlsx"
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/pdf";
}

export function attendanceContentDisposition(data: AttendanceExportJobData): string {
  return `attachment; filename="attendance-summary.${data.fileFormat}"`;
}

export async function renderAttendanceExport(
  deps: ReportRenderDeps<AttendanceExportJobData>,
): Promise<Uint8Array> {
  const replica = deps.replica;
  if (!replica) throw new Error("attendance export requires a read database");
  const report = await withTenantTx(
    replica,
    { schoolId: deps.context.schoolId, userId: deps.context.requestedByUserId },
    (tx) =>
      queryCompleteAttendanceReport(
        tx,
        deps.context.schoolId,
        deps.data.filter,
        deps.data.groupBy,
        deps.data.trendInterval,
      ),
    { readOnly: true },
  );
  const renderInput = {
    generatedAt: deps.now,
    filter: deps.data.filter,
    groupBy: deps.data.groupBy,
    trendInterval: deps.data.trendInterval,
    ...report,
  };
  return deps.data.fileFormat === "xlsx" ? renderXlsx(renderInput) : renderPdf(renderInput);
}
