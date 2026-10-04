import type { ExportFileFormat, ExportJob, ReportType } from "./queries";

// Translation keys (not display strings): resolved with `t()` at render time so labels follow the
// active locale instead of whatever locale was active when this module loaded.

export const REPORT_TYPE_LABEL_KEYS: Record<ReportType, string> = {
  ar_aging: "financeReports.reports.types.ar_aging",
  general_ledger: "financeReports.reports.types.general_ledger",
  collections_vs_due: "financeReports.reports.types.collections_vs_due",
  family_statement: "financeReports.reports.types.family_statement",
};

export const REPORT_TYPE_DESCRIPTION_KEYS: Record<ReportType, string> = {
  ar_aging: "financeReports.reports.typeDescriptions.ar_aging",
  general_ledger: "financeReports.reports.typeDescriptions.general_ledger",
  collections_vs_due: "financeReports.reports.typeDescriptions.collections_vs_due",
  family_statement: "financeReports.reports.typeDescriptions.family_statement",
};

/** File-format names are format codes, identical in every locale — deliberately not translated. */
export function exportFileFormatLabel(format: ExportFileFormat): string {
  return format === "csv" ? "CSV" : "PDF";
}

export const EXPORT_STATUS_LABEL_KEYS: Record<ExportJob["status"], string> = {
  queued: "financeReports.reports.exportStatus.queued",
  processing: "financeReports.reports.exportStatus.processing",
  completed: "financeReports.reports.exportStatus.completed",
  failed: "financeReports.reports.exportStatus.failed",
};

/** `*-status-pill` tone, matching `payments/labels.ts`'s `paymentStatusTone` convention. */
export function exportStatusTone(status: ExportJob["status"]): "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "warning";
}
