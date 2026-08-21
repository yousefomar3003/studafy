import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type Expense = components["schemas"]["Expense"];
export type ExpenseDocumentType = Expense["document_type"];
export type CreateExpenseBody = components["schemas"]["CreateExpenseBody"];
export type ExpenseSummary = components["schemas"]["ExpenseSummary"];
export type ExpenseCategorySummary = components["schemas"]["ExpenseCategorySummary"];
export type UploadUrlBody = components["schemas"]["UploadUrlBody"];
export type UploadUrlResponse = components["schemas"]["UploadUrlResponse"];

const PAGE_SIZE = 20;

export interface ExpenseFilters {
  /** Exact match against the ERPNext category docname (`ec.category = params.category` in the
   * API's `listExpenses`). `""` means "every category" — left off the request rather than sent
   * empty, same convention `payments/queries.ts`'s `PaymentFilters` documents. */
  category: string;
  /** `"YYYY-MM"`. Always set (`ExpenseListPage` defaults it to the current month and never lets it
   * go blank) — expanded to `date_from`/`date_to` here since the API's own query contract only
   * understands day boundaries, not a calendar month. */
  month: string;
}

export interface ExpensesPage {
  items: Expense[];
  total: number;
}

/** The first and last calendar day of `month` (`"YYYY-MM"`), or `null` if `month` isn't that shape. */
export function monthDateRange(month: string): { date_from: string; date_to: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const [, year, monthNum] = match;
  // `new Date(year, monthNum, 0)`: `monthNum` (1-12) as a 0-indexed month means "the month after
  // the target", so day 0 of it is the target month's last day.
  const lastDay = new Date(Number(year), Number(monthNum), 0).getDate();
  return {
    date_from: `${year}-${monthNum}-01`,
    date_to: `${year}-${monthNum}-${String(lastDay).padStart(2, "0")}`,
  };
}

export const EXPENSES_PAGE_SIZE = PAGE_SIZE;

/** One page of `GET /api/finance/expenses`. Offset-based, not cursor-based: like
 * `payments/queries.ts`'s `fetchPaymentsPage`, `expenseQuerySchema` only takes `limit`/`offset`. */
export async function fetchExpensesPage(
  filters: ExpenseFilters,
  offset: number,
): Promise<ExpensesPage> {
  const range = monthDateRange(filters.month);
  const { data } = await api.GET("/api/finance/expenses", {
    params: {
      query: {
        limit: PAGE_SIZE,
        offset,
        category: filters.category || undefined,
        date_from: range?.date_from,
        date_to: range?.date_to,
      },
    },
  });
  // `readonly Expense[]` loses its array prototype through the generated response type here — the
  // same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents for
  // `notifications`.
  return { items: (data?.expenses ?? []) as Expense[], total: data?.total ?? 0 };
}

export function expenseQueryKey(expenseId: string) {
  return ["finance", "expenses", expenseId] as const;
}

export async function fetchExpense(expenseId: string): Promise<Expense> {
  const { data } = await api.GET("/api/finance/expenses/{expenseId}", {
    params: { path: { expenseId } },
  });
  if (!data) throw new Error("Expense not found.");
  return data as Expense;
}

export function expenseSummaryQueryKey(month: string) {
  return ["finance", "expenses", "summary", month] as const;
}

/** Monthly category breakdown for `month` (`"YYYY-MM"`). `null` when `month` isn't that shape —
 * `ExpenseListPage` gates the query on a non-null result rather than sending a malformed request. */
export async function fetchExpenseSummary(month: string): Promise<ExpenseSummary | null> {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const [, year, monthNum] = match;
  const { data } = await api.GET("/api/finance/expenses/summary", {
    params: { query: { year: Number(year), month: Number(monthNum) } },
  });
  return (data ?? null) as ExpenseSummary | null;
}
