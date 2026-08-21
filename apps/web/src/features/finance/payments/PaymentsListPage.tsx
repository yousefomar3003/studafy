import { Button, DataGrid, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { PAYMENT_MODE_LABELS, PAYMENT_STATUS_LABELS, paymentStatusTone } from "../labels";

import { PAYMENTS_PAGE_SIZE, fetchPaymentsPage } from "./queries";

import "./payments.css";

import type { Payment, PaymentFilters, PaymentStatus } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const STATUS_OPTIONS: SelectOption<PaymentStatus | "">[] = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "failed", label: "Failed" },
];

/**
 * Payment history (`/portal/finance/payments`), gated by `billing:read`. Filter by confirmation
 * status; a confirmed row's receipt opens straight from here, which is what makes a reprint just a
 * click rather than a new lookup — issuance already happened once, from `RecordPaymentPage`'s own
 * success state.
 *
 * No student name column: `paymentSchema` carries `student_id` only, not a joined name (see
 * `RecentPaymentsFeedTile`, the only other place this list is read, which has the same gap).
 * Offset-paginated to match the endpoint's own `limit`/`offset` contract — see `fetchPaymentsPage`'s
 * doc comment for why this isn't `@studafy/ui`'s cursor-shaped `useCursorPagination`.
 */
export default function PaymentsListPage() {
  const [status, setStatus] = useState<PaymentStatus | "">("");
  const [offset, setOffset] = useState(0);

  const filters: PaymentFilters = { status };

  const query = useQuery({
    queryKey: ["finance", "payments", "list", filters.status, offset],
    queryFn: () => fetchPaymentsPage(filters, offset),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const hasPreviousPage = offset > 0;
  const hasNextPage = offset + items.length < total;

  function changeStatus(next: PaymentStatus | "") {
    setStatus(next);
    setOffset(0);
  }

  const columns: DataGridColumn<Payment>[] = [
    { id: "payment_date", header: "Date", renderCell: (row) => row.payment_date },
    {
      id: "invoice",
      header: "Invoice",
      renderCell: (row) => row.erpnext_invoice_id ?? "—",
    },
    {
      id: "amount",
      header: "Amount",
      align: "end",
      renderCell: (row) => `${row.amount} ${row.currency}`,
    },
    {
      id: "mode",
      header: "Method",
      renderCell: (row) => (row.payment_mode ? PAYMENT_MODE_LABELS[row.payment_mode] : "—"),
    },
    {
      id: "status",
      header: "Status",
      renderCell: (row) => (
        <span className="payments-status-pill" data-tone={paymentStatusTone(row.status)}>
          {PAYMENT_STATUS_LABELS[row.status]}
        </span>
      ),
    },
    {
      id: "receipt",
      header: "Receipt",
      renderCell: (row) =>
        row.receipt_url ? (
          <a href={row.receipt_url} target="_blank" rel="noopener noreferrer">
            Open receipt
          </a>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <>
      <div className="payments-list__header">
        <div>
          <h1>Payments</h1>
          <p>Every payment recorded for this school, with receipts for confirmed ones.</p>
        </div>
        <Link to="/portal/finance/payments/new">
          <Button>Record payment</Button>
        </Link>
      </div>

      <div className="payments-list__toolbar">
        <Select label="Status" options={STATUS_OPTIONS} value={status} onChange={changeStatus} />
      </div>

      <DataGrid
        caption="Payments"
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.erpnext_invoice_id ?? row.id}
        loading={query.isPending}
        empty={query.isError ? "Unable to load payments." : "No payments match this filter."}
      />

      <div className="payments-list__pagination">
        <Button
          variant="secondary"
          disabled={!hasPreviousPage}
          onClick={() => setOffset(Math.max(0, offset - PAYMENTS_PAGE_SIZE))}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          disabled={!hasNextPage}
          onClick={() => setOffset(offset + PAYMENTS_PAGE_SIZE)}
        >
          Next
        </Button>
      </div>
    </>
  );
}
