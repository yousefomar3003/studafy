import { Button, DataGrid, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";
import { PAYMENT_MODE_LABEL_KEYS, PAYMENT_STATUS_LABEL_KEYS, paymentStatusTone } from "../labels";

import { PAYMENTS_PAGE_SIZE, fetchPaymentsPage } from "./queries";

import "./payments.css";

import type { Payment, PaymentFilters, PaymentStatus } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const STATUS_OPTION_KEYS: { value: PaymentStatus | ""; labelKey: string }[] = [
  { value: "", labelKey: "finance.common.allStatuses" },
  { value: "pending", labelKey: PAYMENT_STATUS_LABEL_KEYS.pending },
  { value: "confirmed", labelKey: PAYMENT_STATUS_LABEL_KEYS.confirmed },
  { value: "failed", labelKey: PAYMENT_STATUS_LABEL_KEYS.failed },
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
  const { t } = useTranslation();
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

  const statusOptions: SelectOption<PaymentStatus | "">[] = STATUS_OPTION_KEYS.map(
    ({ value, labelKey }) => ({ value, label: t(labelKey) }),
  );

  const columns: DataGridColumn<Payment>[] = [
    { id: "payment_date", header: t("finance.common.date"), renderCell: (row) => row.payment_date },
    {
      id: "invoice",
      header: t("finance.common.invoice"),
      renderCell: (row) => row.erpnext_invoice_id ?? "—",
    },
    {
      id: "amount",
      header: t("finance.common.amount"),
      align: "end",
      renderCell: (row) => `${row.amount} ${row.currency}`,
    },
    {
      id: "mode",
      header: t("finance.common.method"),
      renderCell: (row) => (row.payment_mode ? t(PAYMENT_MODE_LABEL_KEYS[row.payment_mode]) : "—"),
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => (
        <span className="payments-status-pill" data-tone={paymentStatusTone(row.status)}>
          {t(PAYMENT_STATUS_LABEL_KEYS[row.status])}
        </span>
      ),
    },
    {
      id: "receipt",
      header: t("finance.payments.list.receipt"),
      renderCell: (row) =>
        row.receipt_url ? (
          <a href={row.receipt_url} target="_blank" rel="noopener noreferrer">
            {t("finance.common.openReceipt")}
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
          <h1>{t("finance.payments.list.title")}</h1>
          <p>{t("finance.payments.list.intro")}</p>
        </div>
        <Link to="/portal/finance/payments/new">
          <Button>{t("finance.common.recordPayment")}</Button>
        </Link>
      </div>

      <div className="payments-list__toolbar">
        <Select
          label={t("finance.common.status")}
          options={statusOptions}
          value={status}
          onChange={changeStatus}
        />
      </div>

      <DataGrid
        caption={t("finance.payments.list.caption")}
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.erpnext_invoice_id ?? row.id}
        loading={query.isPending}
        empty={
          query.isError ? t("finance.payments.list.loadError") : t("finance.payments.list.empty")
        }
      />

      <div className="payments-list__pagination">
        <Button
          variant="secondary"
          disabled={!hasPreviousPage}
          onClick={() => setOffset(Math.max(0, offset - PAYMENTS_PAGE_SIZE))}
        >
          {t("finance.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={!hasNextPage}
          onClick={() => setOffset(offset + PAYMENTS_PAGE_SIZE)}
        >
          {t("finance.common.next")}
        </Button>
      </div>
    </>
  );
}
