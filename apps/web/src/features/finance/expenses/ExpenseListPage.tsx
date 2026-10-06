import { PERMISSIONS } from "@studafy/constants";
import { PAGINATION_MAX_LIMIT } from "@studafy/shared-schemas";
import { Button, Card, DataGrid } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ExportCsvButton } from "../../../components/ExportCsvButton";
import { ImportCsvButton } from "../../../components/ImportCsvButton";
import { usePermissions } from "../../../lib/auth";
import { collectOffsetPages } from "../../../lib/data-transfer";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import { EXPENSE_DOCUMENT_TYPE_LABEL_KEYS, expenseStatusLabel, expenseStatusTone } from "./labels";
import { createExpense } from "./mutations";
import {
  EXPENSES_PAGE_SIZE,
  expenseSummaryQueryKey,
  fetchExpenseSummary,
  fetchExpensesPage,
} from "./queries";

import "./expenses.css";

import type { CreateExpenseBody, Expense, ExpenseDocumentType, ExpenseFilters } from "./queries";
import type { ExportColumn, ImportSpec } from "../../../lib/data-transfer";
import type { DataGridColumn } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;

/** Same rules as `NewExpensePage`'s entry form. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const EXPENSE_DOCUMENT_TYPES = Object.keys(
  EXPENSE_DOCUMENT_TYPE_LABEL_KEYS,
) as ExpenseDocumentType[];

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
  const queryClient = useQueryClient();
  // Same gate as the "Record expense" route (`finance/expenses/new`) and `POST /api/finance/expenses`.
  const canCreate = usePermissions().has(PERMISSIONS.BILLING_UPDATE);
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

  const exportColumns: ExportColumn<Expense>[] = [
    { header: t("finance.common.date"), value: (row) => row.expense_date },
    {
      header: t("finance.common.type"),
      value: (row) => t(EXPENSE_DOCUMENT_TYPE_LABEL_KEYS[row.document_type]),
    },
    { header: t("finance.common.category"), value: (row) => row.category },
    { header: t("finance.common.vendor"), value: (row) => row.vendor },
    { header: t("finance.common.amount"), value: (row) => row.amount },
    { header: t("finance.common.currency"), value: (row) => row.currency },
    {
      header: t("finance.common.status"),
      value: (row) => expenseStatusLabel(row.erpnext_status, t),
    },
    { header: t("finance.common.erpnextDocument"), value: (row) => row.erpnext_name },
    { header: t("finance.common.description"), value: (row) => row.description },
  ];

  // Mirrors `NewExpensePage`'s form: attachments go through the pre-signed upload flow and are not
  // importable, so imported expenses are created without one.
  const importSpec: ImportSpec<CreateExpenseBody> = {
    templateName: "expenses-template",
    fields: [
      {
        key: "document_type",
        label: t("finance.expenses.new.documentType"),
        required: true,
        options: EXPENSE_DOCUMENT_TYPES,
        example: "purchase_invoice",
      },
      {
        key: "expense_date",
        label: t("finance.expenses.new.expenseDate"),
        type: "date",
        example: "2026-09-15",
      },
      {
        key: "category",
        label: t("finance.common.category"),
        required: true,
        maxLength: 200,
        example: "Office Supplies - SCH",
      },
      {
        key: "vendor",
        label: t("finance.common.vendor"),
        required: true,
        maxLength: 200,
        example: "Stationery Co.",
      },
      {
        key: "amount",
        label: t("finance.common.amount"),
        required: true,
        type: "number",
        example: "125.50",
      },
      {
        key: "currency",
        label: t("finance.common.currency"),
        required: true,
        maxLength: 3,
        example: "JOD",
      },
      {
        key: "description",
        label: t("finance.common.description"),
        maxLength: 1000,
        example: "Printer paper",
      },
    ],
    toRecord: (values) => {
      const errors: string[] = [];
      const amount = values.amount as number;
      const currency = String(values.currency).toUpperCase();
      if (!(amount > 0)) errors.push(t("finance.expenses.import.amountPositive"));
      if (!CURRENCY_PATTERN.test(currency)) errors.push(t("finance.expenses.new.currencyInvalid"));
      if (errors.length > 0) return { errors };
      return {
        document_type: values.document_type as ExpenseDocumentType,
        category: String(values.category),
        vendor: String(values.vendor),
        amount,
        currency,
        description: values.description === null ? undefined : String(values.description),
        expense_date: values.expense_date === null ? undefined : String(values.expense_date),
      };
    },
    create: createExpense,
  };

  return (
    <>
      <div className="expenses-list__header">
        <div>
          <h1>{t("finance.expenses.list.title")}</h1>
          <p>{t("finance.expenses.list.intro")}</p>
        </div>
        <div className="expenses-list__header-actions">
          <ExportCsvButton
            filename="expenses"
            columns={exportColumns}
            getRows={() =>
              collectOffsetPages((pageOffset) =>
                fetchExpensesPage(filters, pageOffset, PAGINATION_MAX_LIMIT),
              )
            }
          />
          {canCreate && (
            <ImportCsvButton
              spec={importSpec}
              title={t("finance.expenses.import.title")}
              onImported={() =>
                void queryClient.invalidateQueries({ queryKey: ["finance", "expenses"] })
              }
            />
          )}
          <Link to="/portal/finance/expenses/new">
            <Button>{t("finance.common.recordExpense")}</Button>
          </Link>
        </div>
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
