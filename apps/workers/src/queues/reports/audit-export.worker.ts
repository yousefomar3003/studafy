/**
 * Audit-log CSV export report type (ST-046x).
 *
 * The audit half of a registry entry: the deterministic object key, the renderer, and the content
 * headers. The renderer streams the full filtered range from app.audit_logs oldest-first, under a
 * `withSystemTenantTx` on the primary pool — unlike attendance/finance there is no per-user role
 * scope to honour, so no replica is needed. The stored `parameters` (resolved filter) are parsed
 * back from the claimed row; the queue payload never carries them.
 */

import {
  auditExportParametersSchema,
  auditLogCsvHeader,
  auditLogEntryToCsv,
  queryAuditLogExportRows,
} from "@studafy/audit-reporting";

import { withSystemTenantTx } from "../../db/tenant-tx";

import type { AuditReportJobRow } from "./audit-report-store";
import type { ReportRenderDeps } from "./report-types";
import type { AuditExportJobData } from "@studafy/audit-reporting";

export { isFinalAttempt as isFinalExportAttempt } from "./report-runner";

const CSV_ROW_TERMINATOR = "\r\n";

export function auditReportStorageKey(data: AuditExportJobData): string {
  return `reports/${data.schoolId}/${data.jobId}/audit-log-export.csv`;
}

export function auditContentType(): string {
  return "text/csv; charset=utf-8";
}

export function auditContentDisposition(_data: AuditExportJobData): string {
  return `attachment; filename="audit-log-export.csv"`;
}

export async function renderAuditExport(
  deps: ReportRenderDeps<AuditExportJobData, AuditReportJobRow>,
): Promise<Uint8Array> {
  const row = deps.record;
  if (!row) throw new Error("audit export job record is missing");
  const filter = auditExportParametersSchema.parse(row.parameters);

  const chunks: Uint8Array[] = [new TextEncoder().encode(auditLogCsvHeader() + CSV_ROW_TERMINATOR)];
  await withSystemTenantTx(deps.primary, { schoolId: deps.context.schoolId }, async (tx) => {
    const encoder = new TextEncoder();
    for await (const entry of queryAuditLogExportRows(tx, deps.context.schoolId, filter)) {
      chunks.push(encoder.encode(auditLogEntryToCsv(entry) + CSV_ROW_TERMINATOR));
    }
  });
  return Buffer.concat(chunks);
}
