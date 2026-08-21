import { api } from "../../../lib/api";

import type { FinanceReportResponse } from "../queries";
import type { components } from "@studafy/api-client";

export type { FinanceReportResponse } from "../queries";
export type { ReportColumn } from "../queries";

export type ExportJob = components["schemas"]["FinanceExportJob"];
export type ExportRequest = components["schemas"]["FinanceExportRequest"];
export type Family = components["schemas"]["Family"];

/** The report center only runs/downloads the four ERPNext-backed reports the gateway serves —
 * `joinvoice_export` is a per-invoice compliance artifact with its own flow (invoice detail's
 * "Download JoInvoice"), not a report-center report. */
export type ReportType = Exclude<ExportJob["report_type"], "joinvoice_export">;
export type ExportFileFormat = "csv" | "pdf";

/**
 * Mirrors `components["schemas"]["FamilyStatementResponse"]` with plain (mutable) arrays, same
 * reasoning `finance/queries.ts`'s own `FinanceReportResponse` doc comment gives for its cast: the
 * generated type's `readonly unknown[]` fields lose their array prototype through `api.GET`'s
 * response typing.
 */
export interface FamilyStatementResponse {
  family_id: string;
  student_ids: string[];
  customer_ids: string[];
  accounts_receivable: FinanceReportResponse;
  general_ledger: FinanceReportResponse;
  household_totals: unknown[];
}

function joinStudentIds(studentIds: string[] | undefined): string | undefined {
  return studentIds && studentIds.length > 0 ? studentIds.join(",") : undefined;
}

// ---------------------------------------------------------------------------
// Synchronous report runs
// ---------------------------------------------------------------------------

export interface StudentScopedFilters {
  reportDate?: string;
  /** At most one student in the report-center UI (see `StudentPickerField`'s doc comment) — the API
   * itself accepts many, but a single scoping student covers the report center's own use case
   * without a multi-select. */
  studentIds?: string[];
}

export async function fetchArAgingReport(
  filters: StudentScopedFilters = {},
): Promise<FinanceReportResponse | undefined> {
  const { data } = await api.GET("/api/finance/reports/ar-aging", {
    params: {
      query: { report_date: filters.reportDate, student_ids: joinStudentIds(filters.studentIds) },
    },
  });
  return data as FinanceReportResponse | undefined;
}

export async function fetchCollectionsVsDueReport(
  filters: StudentScopedFilters = {},
): Promise<FinanceReportResponse | undefined> {
  const { data } = await api.GET("/api/finance/reports/collections-vs-due", {
    params: {
      query: { report_date: filters.reportDate, student_ids: joinStudentIds(filters.studentIds) },
    },
  });
  return data as FinanceReportResponse | undefined;
}

export interface GeneralLedgerFilters {
  fromDate: string;
  toDate: string;
  studentIds?: string[];
  account?: string;
  voucherNo?: string;
  voucherType?: string;
}

export async function fetchGeneralLedgerReport(
  filters: GeneralLedgerFilters,
): Promise<FinanceReportResponse | undefined> {
  const { data } = await api.GET("/api/finance/reports/general-ledger", {
    params: {
      query: {
        from_date: filters.fromDate,
        to_date: filters.toDate,
        student_ids: joinStudentIds(filters.studentIds),
        account: filters.account || undefined,
        voucher_no: filters.voucherNo || undefined,
        voucher_type: filters.voucherType || undefined,
      },
    },
  });
  return data as FinanceReportResponse | undefined;
}

export interface FamilyStatementFilters {
  fromDate?: string;
  toDate?: string;
}

export async function fetchFamilyStatement(
  familyId: string,
  filters: FamilyStatementFilters = {},
): Promise<FamilyStatementResponse | undefined> {
  const { data } = await api.GET("/api/finance/reports/family-statement/{familyId}", {
    params: { path: { familyId }, query: { from_date: filters.fromDate, to_date: filters.toDate } },
  });
  return data as FamilyStatementResponse | undefined;
}

// ---------------------------------------------------------------------------
// Asynchronous exports
// ---------------------------------------------------------------------------

export function exportJobQueryKey(jobId: string) {
  return ["finance", "reports", "export", jobId] as const;
}

export async function fetchExportJob(jobId: string): Promise<ExportJob> {
  const { data } = await api.GET("/api/finance/reports/export/{jobId}", {
    params: { path: { jobId } },
  });
  if (!data) throw new Error("Export job not found.");
  return data as ExportJob;
}

// ---------------------------------------------------------------------------
// Family picker
// ---------------------------------------------------------------------------

export function familySearchQueryKey(search: string) {
  return ["finance", "reports", "family-search", search] as const;
}

const FAMILY_SEARCH_LIMIT = 10;

export async function searchFamilies(search: string): Promise<Family[]> {
  const { data } = await api.GET("/api/families", {
    params: { query: { search, limit: FAMILY_SEARCH_LIMIT } },
  });
  // `readonly Family[]` loses its array prototype through the generated response type here — the
  // same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents for
  // `notifications`.
  return (data?.families ?? []) as Family[];
}
