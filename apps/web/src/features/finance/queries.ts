import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";

/**
 * Mirrors `components["schemas"]["FinanceReportResponse"]` with plain (mutable) arrays. The
 * generated type's `readonly unknown[]` fields lose their array prototype through `api.GET`'s
 * response typing — the same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx`
 * documents for `notifications` — so fetchers below cast into this shape instead of the generated
 * one, restoring `.map`/`.filter`/`.reduce` without widening to `any`.
 */
export interface FinanceReportResponse {
  report_name: string;
  columns: unknown[];
  rows: unknown[];
  report_summary: unknown[];
  presentation: {
    locale: "en" | "ar";
    direction: "ltr" | "rtl";
    currency: "JOD";
    currency_precision: 3;
    currency_display: Record<string, string>[];
  };
}

export type Payment = components["schemas"]["Payment"];

/** Local calendar date as YYYY-MM-DD, matching `AttendanceHeatMapTile`'s `dateString` helper. */
export function todayIsoDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Report shape helpers
//
// `columns`/`rows`/`report_summary` are `unknown[]` in the OpenAPI contract — ERPNext's own report
// shape, which Studafy passes through rather than re-validating (see
// docs/modules/finance-reports-definitions.md). Everything below narrows that `unknown` defensively:
// a column this dashboard expects but doesn't find means "don't render that part," never a guess.
// ---------------------------------------------------------------------------

export interface ReportColumn {
  fieldname?: string;
  label?: string;
  fieldtype?: string;
}

interface IndexedColumn {
  column: ReportColumn;
  index: number;
}

function isReportColumn(value: unknown): value is ReportColumn {
  return value !== null && typeof value === "object";
}

function indexedColumns(report: FinanceReportResponse): IndexedColumn[] {
  const result: IndexedColumn[] = [];
  report.columns.forEach((column, index) => {
    if (isReportColumn(column)) result.push({ column, index });
  });
  return result;
}

/** A report row's value for one column. ERPNext query reports return rows either positionally
 * (array, matched by column order) or by fieldname (dict) depending on the report's own
 * implementation — both are read the same way here. */
function cellValue(row: unknown, { column, index }: IndexedColumn): unknown {
  // `index` and `column.fieldname` are drawn only from the report's own `columns` metadata, never
  // external input — the same bounded-key shape `role-home.ts` documents for this rule.
  /* eslint-disable security/detect-object-injection */
  if (Array.isArray(row)) return row[index];
  if (row !== null && typeof row === "object" && column.fieldname) {
    return (row as Record<string, unknown>)[column.fieldname];
  }
  /* eslint-enable security/detect-object-injection */
  return undefined;
}

function findColumn(
  columns: readonly IndexedColumn[],
  fieldnames: readonly string[],
): IndexedColumn | undefined {
  for (const fieldname of fieldnames) {
    const found = columns.find((entry) => entry.column.fieldname === fieldname);
    if (found) return found;
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Formats a client-computed total (e.g. a bucket sum) at the report's own currency precision,
 * rather than hardcoding JOD's 3 decimal places — see `currency.ts` on the API side for why that
 * exponent is never assumed. */
export function formatAmount(value: number, report: FinanceReportResponse): string {
  return value.toFixed(report.presentation.currency_precision);
}

// ---------------------------------------------------------------------------
// Aging buckets — ar-aging ("Accounts Receivable Summary"), one row per party
// ---------------------------------------------------------------------------

export interface AgingBucket {
  fieldname: string;
  label: string;
  total: number;
}

/** ERPNext names this report's aging columns `range1`..`rangeN`; the API always fixes the filter
 * boundaries at 30/60/90 days (see `buildFilters` in `reports/service.ts`), so these are always
 * "0-30", "31-60", "61-90", "90-Above" in whatever locale the request asked for. */
const AGING_BUCKET_PATTERN = /^range\d+$/i;

/** One bucket per matching column, summed across every party row. Studafy never computes aging
 * itself (see docs/modules/finance-reports-definitions.md) — this only totals what ERPNext already
 * returned, using ERPNext's own column labels. */
export function agingBuckets(report: FinanceReportResponse): AgingBucket[] {
  return indexedColumns(report)
    .filter(
      ({ column }) =>
        column.fieldtype === "Currency" &&
        typeof column.fieldname === "string" &&
        AGING_BUCKET_PATTERN.test(column.fieldname),
    )
    .map((entry) => ({
      fieldname: entry.column.fieldname as string,
      label: entry.column.label ?? (entry.column.fieldname as string),
      total: report.rows.reduce<number>(
        (sum, row) => sum + toFiniteNumber(cellValue(row, entry)),
        0,
      ),
    }));
}

/** Matches `AGING_BUCKET_PATTERN`'s fixed 30/60/90 day boundaries, for mapping an installment's own
 * due date onto the same buckets the aging chart shows (see `overdueInstallments` below). */
export function bucketForDaysOverdue(daysOverdue: number): string {
  if (daysOverdue <= 30) return "range1";
  if (daysOverdue <= 60) return "range2";
  if (daysOverdue <= 90) return "range3";
  return "range4";
}

/** Whole days between two YYYY-MM-DD dates. Only ever called with ERPNext's own date strings, so no
 * timezone handling beyond what `Date` gives a plain calendar date. */
export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  const from = new Date(fromIsoDate).getTime();
  const to = new Date(toIsoDate).getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Overdue installments — collections-vs-due ("Accounts Receivable", by payment term)
// ---------------------------------------------------------------------------

export interface OverdueInstallment {
  dueDate: string;
  daysOverdue: number;
  bucket: string;
  outstandingDisplay: string;
  outstandingValue: number;
  partyName: string;
  reference: string;
}

const DUE_DATE_FIELDNAMES = ["due_date", "posting_date"] as const;
const OUTSTANDING_FIELDNAMES = ["outstanding_amount", "outstanding", "outstanding_amt"] as const;
const PARTY_NAME_FIELDNAMES = ["party_name", "party"] as const;
const REFERENCE_FIELDNAMES = ["voucher_no", "invoice", "reference_name"] as const;

/**
 * Rows from `collections-vs-due` that are past `today` with a balance still owed, oldest due date
 * first. Returns `null` rather than guessing when the report doesn't carry the due-date or
 * outstanding-amount column this needs — an honest "can't show this" beats a table built from the
 * wrong field.
 */
export function overdueInstallments(
  report: FinanceReportResponse,
  today: string,
): OverdueInstallment[] | null {
  const columns = indexedColumns(report);
  const dueDateColumn = findColumn(columns, DUE_DATE_FIELDNAMES);
  const outstandingColumn = findColumn(columns, OUTSTANDING_FIELDNAMES);
  if (!dueDateColumn || !outstandingColumn) return null;

  const partyColumn = findColumn(columns, PARTY_NAME_FIELDNAMES);
  const referenceColumn = findColumn(columns, REFERENCE_FIELDNAMES);
  const outstandingFieldname = outstandingColumn.column.fieldname;

  return report.rows
    .map((row, rowIndex): OverdueInstallment => {
      const dueDate = String(cellValue(row, dueDateColumn) ?? "");
      const outstandingValue = toFiniteNumber(cellValue(row, outstandingColumn));
      const daysOverdue = daysBetween(dueDate, today);

      // `outstandingFieldname` and `rowIndex` are drawn only from this report's own metadata and
      // rows, never external input — the same bounded-key shape `role-home.ts` documents for this
      // rule.
      /* eslint-disable security/detect-object-injection */
      const apiFormattedOutstanding = outstandingFieldname
        ? report.presentation.currency_display[rowIndex]?.[outstandingFieldname]
        : undefined;
      /* eslint-enable security/detect-object-injection */

      return {
        dueDate,
        daysOverdue,
        bucket: bucketForDaysOverdue(daysOverdue),
        outstandingValue,
        outstandingDisplay: apiFormattedOutstanding || formatAmount(outstandingValue, report),
        partyName: partyColumn ? String(cellValue(row, partyColumn) ?? "") : "",
        reference: referenceColumn ? String(cellValue(row, referenceColumn) ?? "") : "",
      };
    })
    .filter(
      (installment) =>
        installment.dueDate !== "" &&
        installment.dueDate < today &&
        installment.outstandingValue > 0,
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

// ---------------------------------------------------------------------------
// Report summary cards — collections-vs-due KPI numbers ("collections vs due this term")
// ---------------------------------------------------------------------------

export interface ReportSummaryCard {
  label: string;
  display: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** ERPNext's own `report_summary` cards, verbatim. Studafy does not compute collections or due
 * totals (see docs/modules/finance-reports-definitions.md) — these cards are the only source for
 * "collections vs due this term," so the tile renders them as-is rather than deriving its own. */
export function reportSummaryCards(report: FinanceReportResponse): ReportSummaryCard[] {
  return report.report_summary.filter(isRecord).map((entry) => {
    const label = typeof entry.label === "string" ? entry.label : "";
    const value = entry.value;
    const display =
      typeof value === "number"
        ? formatAmount(value, report)
        : typeof value === "string"
          ? value
          : "—";
    return { label, display };
  });
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export async function fetchArAgingReport(): Promise<FinanceReportResponse | undefined> {
  const { data } = await api.GET("/api/finance/reports/ar-aging");
  return data as FinanceReportResponse | undefined;
}

export async function fetchCollectionsVsDueReport(): Promise<FinanceReportResponse | undefined> {
  const { data } = await api.GET("/api/finance/reports/collections-vs-due");
  return data as FinanceReportResponse | undefined;
}

const RECENT_PAYMENTS_LIMIT = 10;

export async function fetchRecentPayments(): Promise<{ payments: Payment[]; total: number }> {
  const { data } = await api.GET("/api/finance/payments", {
    params: { query: { limit: RECENT_PAYMENTS_LIMIT, offset: 0 } },
  });
  // `readonly Payment[]` loses its array prototype through the generated response type here — the
  // same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents for
  // `notifications`. The annotation restores it without widening to `any`.
  return {
    payments: (data?.payments ?? []) as Payment[],
    total: data?.total ?? 0,
  };
}

export const COLLECTIONS_VS_DUE_QUERY_KEY = ["finance", "collections-vs-due"] as const;
export const AR_AGING_QUERY_KEY = ["finance", "ar-aging"] as const;
export const RECENT_PAYMENTS_QUERY_KEY = ["finance", "payments", "recent"] as const;
