import { Button, Card, DataGrid } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { EXPENSE_DOCUMENT_TYPE_LABEL_KEYS, expenseStatusLabel, expenseStatusTone } from "./labels";
import {
  EXPENSES_PAGE_SIZE,
  expenseSummaryQueryKey,
  fetchExpenseSummary,
  fetchExpensesPage,
} from "./queries";

import "./expenses.css";

import type { Expense, ExpenseFilters } from "./queries";
import type { DataGridColumn } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** The first day of a `YYYY-MM` month as a local `Date`, for locale-aware month formatting. */
function monthStart(month: string): Date {
  const [year, monthNum] = month.split("-").map(Number);
  return new Date(year!, monthNum! - 1, 1);
}

/**
 * Expense list (`/portal/finance/expenses`), gated by `billing:read`. Category is a free-text
 * exact-match filter — there is no endpoint that enumerates categories, since ERPNext owns their
 * existence (see `labels.ts`'s `CATEGORY_FIELD_LABELS` doc comment) — and month always has a value,
 * driving both the list's `date_from`/`date_to` range and the monthly summary panel below it from a
 * single control rather than asking the user to keep two pickers in sync.
 */
export default function ExpenseListPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [categoryInput, setCategoryInput] = useState("");
  const [category, setCategory] = useState("");
  const [month, setMonth] = useState(currentMonth);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const handle = setTimeout(() => setCategory(categoryInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [categoryInput]);

  useEffect(() => {
    setOffset(0);
  }, [category, month]);

  const filters: ExpenseFilters = { category, month };
  const listQuery = useQuery({
    queryKey: ["finance", "expenses", "list", category, month, offset],
    queryFn: () => fetchExpensesPage(filters, offset),
  });

  const summaryQuery = useQuery({
    queryKey: expenseSummaryQueryKey(month),
    queryFn: () => fetchExpenseSummary(month),
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const hasPreviousPage = offset > 0;
  const hasNextPage = offset + items.length < total;
  const summary = summaryQuery.data;
  const monthLabel = formatDate(monthStart(month), { month: "long", year: "numeric" });

  const columns: DataGridColumn<Expense>[] = [
    { id: "expense_date", header: t("finance.common.date"), renderCell: (row) => row.expense_date },
    {
      id: "document_type",
      header: t("finance.common.type"),
      renderCell: (row) => t(EXPENSE_DOCUMENT_TYPE_LABEL_KEYS[row.document_type]),
    },
    {
      id: "category",
      header: t("finance.common.category"),
      renderCell: (row) => <Link to={`/portal/finance/expenses/${row.id}`}>{row.category}</Link>,
    },
    { id: "vendor", header: t("finance.common.vendor"), renderCell: (row) => row.vendor },
    {
      id: "amount",
      header: t("finance.common.amount"),
      align: "end",
      renderCell: (row) => `${row.amount} ${row.currency}`,
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => (
        <span className="expenses-status-pill" data-tone={expenseStatusTone(row.erpnext_status)}>
          {expenseStatusLabel(row.erpnext_status, t)}
        </span>
      ),
    },
  ];

  return (
    <>
      <div className="expenses-list__header">
        <div>
          <h1>{t("finance.expenses.list.title")}</h1>
          <p>{t("finance.expenses.list.intro")}</p>
        </div>
        <Link to="/portal/finance/expenses/new">
          <Button>{t("finance.common.recordExpense")}</Button>
        </Link>
      </div>

      <div className="expenses-list__toolbar">
        <label className="sf-visually-hidden" htmlFor="expenses-category">
          {t("finance.expenses.list.filterCategory")}
        </label>
        <input
          id="expenses-category"
          type="search"
          className="expenses-list__search"
          placeholder={t("finance.expenses.list.filterCategoryPlaceholder")}
          value={categoryInput}
          onChange={(event) => setCategoryInput(event.target.value)}
        />
        <label className="sf-visually-hidden" htmlFor="expenses-month">
          {t("finance.expenses.list.filterMonth")}
        </label>
        <input
          id="expenses-month"
          type="month"
          className="expenses-list__month"
          value={month}
          onChange={(event) => setMonth(event.target.value || currentMonth())}
        />
      </div>

      <DataGrid
        caption={t("finance.expenses.list.caption")}
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.category}
        loading={listQuery.isPending}
        empty={
          listQuery.isError
            ? t("finance.expenses.list.loadError")
            : t("finance.expenses.list.empty")
        }
      />

      <div className="expenses-list__pagination">
        <Button
          variant="secondary"
          disabled={!hasPreviousPage}
          onClick={() => setOffset(Math.max(0, offset - EXPENSES_PAGE_SIZE))}
        >
          {t("finance.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={!hasNextPage}
          onClick={() => setOffset(offset + EXPENSES_PAGE_SIZE)}
        >
          {t("finance.common.next")}
        </Button>
      </div>

      <div className="expenses-summary">
        <Card as="section" aria-label={t("finance.expenses.list.summaryLabel")}>
          <Card.Body>
            <h2>{t("finance.expenses.list.summaryHeading", { month: monthLabel })}</h2>
            {summaryQuery.isPending ? (
              <p>{t("finance.common.loading")}</p>
            ) : summaryQuery.isError ? (
              <p role="alert">{t("finance.expenses.list.summaryError")}</p>
            ) : summary && summary.categories.length > 0 ? (
              <table className="expenses-summary__table">
                <caption className="sf-visually-hidden">
                  {t("finance.expenses.list.summaryHeading", { month: monthLabel })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t("finance.common.category")}</th>
                    <th scope="col">{t("finance.expenses.list.count")}</th>
                    <th scope="col">{t("finance.common.total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.categories.map((row) => (
                    <tr key={row.category}>
                      <td>{row.category}</td>
                      <td>{row.count}</td>
                      <td>{row.total_amount}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">{t("finance.expenses.list.grandTotal")}</th>
                    <td />
                    <td>{summary.grand_total}</td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              <p className="expenses-summary__empty">{t("finance.expenses.list.summaryEmpty")}</p>
            )}
          </Card.Body>
        </Card>
      </div>
    </>
  );
}
