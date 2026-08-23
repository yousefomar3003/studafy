import { Button, Card, DataGrid } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { EXPENSE_DOCUMENT_TYPE_LABELS, expenseStatusLabel, expenseStatusTone } from "./labels";
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

function monthLabel(month: string): string {
  const [year, monthNum] = month.split("-").map(Number);
  return new Date(year!, monthNum! - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

/**
 * Expense list (`/portal/finance/expenses`), gated by `billing:read`. Category is a free-text
 * exact-match filter — there is no endpoint that enumerates categories, since ERPNext owns their
 * existence (see `labels.ts`'s `CATEGORY_FIELD_LABELS` doc comment) — and month always has a value,
 * driving both the list's `date_from`/`date_to` range and the monthly summary panel below it from a
 * single control rather than asking the user to keep two pickers in sync.
 */
export default function ExpenseListPage() {
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

  const columns: DataGridColumn<Expense>[] = [
    { id: "expense_date", header: "Date", renderCell: (row) => row.expense_date },
    {
      id: "document_type",
      header: "Type",
      renderCell: (row) => EXPENSE_DOCUMENT_TYPE_LABELS[row.document_type],
    },
    {
      id: "category",
      header: "Category",
      renderCell: (row) => <Link to={`/portal/finance/expenses/${row.id}`}>{row.category}</Link>,
    },
    { id: "vendor", header: "Vendor", renderCell: (row) => row.vendor },
    {
      id: "amount",
      header: "Amount",
      align: "end",
      renderCell: (row) => `${row.amount} ${row.currency}`,
    },
    {
      id: "status",
      header: "Status",
      renderCell: (row) => (
        <span className="expenses-status-pill" data-tone={expenseStatusTone(row.erpnext_status)}>
          {expenseStatusLabel(row.erpnext_status)}
        </span>
      ),
    },
  ];

  return (
    <>
      <div className="expenses-list__header">
        <div>
          <h1>Expenses</h1>
          <p>Filter by category or month, then select an expense to view its receipt.</p>
        </div>
        <Link to="/portal/finance/expenses/new">
          <Button>Record expense</Button>
        </Link>
      </div>

      <div className="expenses-list__toolbar">
        <label className="sf-visually-hidden" htmlFor="expenses-category">
          Filter by category
        </label>
        <input
          id="expenses-category"
          type="search"
          className="expenses-list__search"
          placeholder="Filter by category…"
          value={categoryInput}
          onChange={(event) => setCategoryInput(event.target.value)}
        />
        <label className="sf-visually-hidden" htmlFor="expenses-month">
          Filter by month
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
        caption="Expenses"
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.category}
        loading={listQuery.isPending}
        empty={listQuery.isError ? "Unable to load expenses." : "No expenses match this filter."}
      />

      <div className="expenses-list__pagination">
        <Button
          variant="secondary"
          disabled={!hasPreviousPage}
          onClick={() => setOffset(Math.max(0, offset - EXPENSES_PAGE_SIZE))}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          disabled={!hasNextPage}
          onClick={() => setOffset(offset + EXPENSES_PAGE_SIZE)}
        >
          Next
        </Button>
      </div>

      <div className="expenses-summary">
        <Card as="section" aria-label="Monthly summary">
          <Card.Body>
            <h2>Monthly summary &mdash; {monthLabel(month)}</h2>
            {summaryQuery.isPending ? (
              <p>Loading&hellip;</p>
            ) : summaryQuery.isError ? (
              <p role="alert">Unable to load the monthly summary.</p>
            ) : summary && summary.categories.length > 0 ? (
              <table className="expenses-summary__table">
                <caption className="sf-visually-hidden">
                  Monthly summary — {monthLabel(month)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col">Count</th>
                    <th scope="col">Total</th>
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
                    <th scope="row">Grand total</th>
                    <td />
                    <td>{summary.grand_total}</td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              <p className="expenses-summary__empty">No expenses recorded for this month.</p>
            )}
          </Card.Body>
        </Card>
      </div>
    </>
  );
}
