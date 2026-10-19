import { Button, DataGrid, Select, useCursorPagination } from "@studafy/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";

import { invoiceStatusLabel, invoiceStatusTone } from "./labels";
import { fetchInvoicesPage } from "./queries";

import "./invoices.css";

import type { Invoice, InvoiceFilters } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;

const STATUS_OPTION_KEYS: { value: string; labelKey: string }[] = [
  { value: "", labelKey: "finance.common.allStatuses" },
  { value: "draft", labelKey: "finance.docStatus.draft" },
  { value: "submitted", labelKey: "finance.docStatus.submitted" },
  { value: "cancelled", labelKey: "finance.docStatus.cancelled" },
];

/**
 * Invoice list (`/portal/finance/invoices`), gated by `billing:read`. Status filter and a single
 * search field for "student or invoice number" — the number half of that search is server-side
 * exact-match-first (see `listInvoices`'s doc comment in the API's `service.ts`), so this page does
 * not need to guess which kind of value the caller typed.
 *
 * Paginated with `@studafy/ui`'s `useCursorPagination` rather than TanStack Query: unlike
 * `StudentsListPage`, nothing on this page mutates the list, so there is no cache to patch
 * optimistically and the purpose-built hook is the simpler fit.
 */
export default function InvoiceListPage() {
  const { t } = useTranslation();
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const filters: InvoiceFilters = { status, search: debouncedSearch };

  // `filters` is a fresh object every render; its two primitive fields are the real dependency,
  // matching useCursorPagination's own "memoize over whatever filters it captures" contract.
  const fetchPage = useCallback(
    (cursor: string | undefined) => fetchInvoicesPage(filters, cursor),
    [filters.status, filters.search],
  );

  const { items, loading, error, hasNextPage, hasPreviousPage, goToNextPage, goToPreviousPage } =
    useCursorPagination(fetchPage);

  const statusOptions: SelectOption<string>[] = STATUS_OPTION_KEYS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  }));

  const columns: DataGridColumn<Invoice>[] = [
    {
      id: "erpnext_docname",
      header: t("finance.invoices.list.invoiceNumber"),
      renderCell: (row) => (
        <Link to={`/portal/finance/invoices/${row.id}`}>{row.erpnext_docname}</Link>
      ),
    },
    {
      id: "student_name",
      header: t("finance.common.student"),
      renderCell: (row) => row.student_name,
    },
    {
      id: "admission_number",
      header: t("finance.common.admissionNumber"),
      renderCell: (row) => row.admission_number,
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => (
        <span className="invoices-status-pill" data-tone={invoiceStatusTone(row.erpnext_status)}>
          {invoiceStatusLabel(row.erpnext_status, t)}
        </span>
      ),
    },
    {
      id: "total",
      header: t("finance.common.total"),
      align: "end",
      renderCell: (row) => `${row.total_amount} ${row.currency}`,
    },
    {
      id: "outstanding",
      header: t("finance.common.outstanding"),
      align: "end",
      renderCell: (row) => `${row.outstanding_amount} ${row.currency}`,
    },
    { id: "issued_date", header: t("finance.common.issued"), renderCell: (row) => row.issued_date },
    { id: "due_date", header: t("finance.common.due"), renderCell: (row) => row.due_date ?? "—" },
  ];

  return (
    <>
      <div className="invoices-list__header">
        <div>
          <h1>{t("finance.invoices.list.title")}</h1>
          <p>{t("finance.invoices.list.intro")}</p>
        </div>
        <Link to="/portal/finance/invoices/batches/new">
          <Button variant="secondary">{t("finance.invoices.list.generate")}</Button>
        </Link>
      </div>

      <div className="invoices-list__toolbar">
        <label className="sf-visually-hidden" htmlFor="invoices-search">
          {t("finance.common.searchByStudentOrInvoice")}
        </label>
        <input
          id="invoices-search"
          type="search"
          className="invoices-list__search"
          placeholder={t("finance.invoices.list.searchPlaceholder")}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <Select
          label={t("finance.common.status")}
          options={statusOptions}
          value={status}
          onChange={setStatus}
        />
      </div>

      <DataGrid
        caption={t("finance.invoices.list.caption")}
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.erpnext_docname}
        loading={loading}
        empty={error ? t("finance.invoices.list.loadError") : t("finance.invoices.list.empty")}
      />

      <div className="invoices-list__pagination">
        <Button variant="secondary" disabled={!hasPreviousPage} onClick={goToPreviousPage}>
          {t("finance.common.previous")}
        </Button>
        <Button variant="secondary" disabled={!hasNextPage} onClick={goToNextPage}>
          {t("finance.common.next")}
        </Button>
      </div>
    </>
  );
}
