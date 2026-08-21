import type { ExportFileFormat, ExportJob, ReportType } from "./queries";

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  ar_aging: "Accounts receivable aging",
  general_ledger: "General ledger",
  collections_vs_due: "Collections vs due",
  family_statement: "Family statement",
};

export const REPORT_TYPE_DESCRIPTIONS: Record<ReportType, string> = {
  ar_aging: "Outstanding balances by household, aged into 30/60/90-day buckets.",
  general_ledger: "Every posted transaction in a date range, account by account.",
  collections_vs_due: "What's been collected against what's due this term, by payment term.",
  family_statement: "One household's receivables and ledger activity, side by side.",
};

export function exportFileFormatLabel(format: ExportFileFormat): string {
  return format === "csv" ? "CSV" : "PDF";
}

export const EXPORT_STATUS_LABELS: Record<ExportJob["status"], string> = {
  queued: "Queued",
  processing: "Processing",
  completed: "Ready",
  failed: "Failed",
};

/** `*-status-pill` tone, matching `payments/labels.ts`'s `paymentStatusTone` convention. */
export function exportStatusTone(status: ExportJob["status"]): "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "warning";
}
