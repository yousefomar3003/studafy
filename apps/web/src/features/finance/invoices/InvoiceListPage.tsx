import { Button, DataGrid, Select, useCursorPagination } from "@studafy/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { invoiceStatusLabel, invoiceStatusTone } from "./labels";
import { fetchInvoicesPage } from "./queries";

import "./invoices.css";

import type { Invoice, InvoiceFilters } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;

const STATUS_OPTIONS: SelectOption<string>[] = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Submitted" },
  { value: "cancelled", label: "Cancelled" },
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

  const columns: DataGridColumn<Invoice>[] = [
    {
      id: "erpnext_docname",
      header: "Invoice #",
      renderCell: (row) => (
        <Link to={`/portal/finance/invoices/${row.id}`}>{row.erpnext_docname}</Link>
      ),
    },
    { id: "student_name", header: "Student", renderCell: (row) => row.student_name },
    { id: "admission_number", header: "Admission #", renderCell: (row) => row.admission_number },
    {
      id: "status",
      header: "Status",
      renderCell: (row) => (
        <span className="invoices-status-pill" data-tone={invoiceStatusTone(row.erpnext_status)}>
          {invoiceStatusLabel(row.erpnext_status)}
        </span>
      ),
    },
    {
      id: "total",
      header: "Total",
      align: "end",
      renderCell: (row) => `${row.total_amount} ${row.currency}`,
    },
    {
      id: "outstanding",
      header: "Outstanding",
      align: "end",
      renderCell: (row) => `${row.outstanding_amount} ${row.currency}`,
    },
    { id: "issued_date", header: "Issued", renderCell: (row) => row.issued_date },
    { id: "due_date", header: "Due", renderCell: (row) => row.due_date ?? "—" },
  ];

  return (
    <>
      <div className="invoices-list__header">
        <div>
          <h1>Invoices</h1>
          <p>Search by student or invoice number, and filter by status.</p>
        </div>
        <Link to="/portal/finance/invoices/batches/new">
          <Button variant="secondary">Generate invoices</Button>
        </Link>
      </div>

      <div className="invoices-list__toolbar">
        <label className="sf-visually-hidden" htmlFor="invoices-search">
          Search by student or invoice number
        </label>
        <input
          id="invoices-search"
          type="search"
          className="invoices-list__search"
          placeholder="Search by student or invoice number…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <Select label="Status" options={STATUS_OPTIONS} value={status} onChange={setStatus} />
      </div>

      <DataGrid
        caption="Invoices"
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.erpnext_docname}
        loading={loading}
        empty={error ? "Unable to load invoices." : "No invoices match this filter."}
      />

      <div className="invoices-list__pagination">
        <Button variant="secondary" disabled={!hasPreviousPage} onClick={goToPreviousPage}>
          Previous
        </Button>
        <Button variant="secondary" disabled={!hasNextPage} onClick={goToNextPage}>
          Next
        </Button>
      </div>
    </>
  );
}
