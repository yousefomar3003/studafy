import { PERMISSIONS } from "@studafy/constants";
import { Button, DataGrid, Input, Select } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";
import { CorrectionRequestModal } from "../adjustments/CorrectionRequestModal";
import { PAYMENT_MODE_LABEL_KEYS, PAYMENT_STATUS_LABEL_KEYS, paymentStatusTone } from "../labels";
import { ReceiptButton } from "../ReceiptButton";

import { PAYMENTS_PAGE_SIZE, fetchPaymentsPage } from "./queries";

import "./payments.css";

import type { PaymentFilters, PaymentMode, PaymentStatus } from "./queries";
import type { PaymentListItem } from "../queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const STATUS_OPTION_KEYS: { value: PaymentStatus | ""; labelKey: string }[] = [
  { value: "", labelKey: "finance.common.allStatuses" },
  { value: "pending", labelKey: PAYMENT_STATUS_LABEL_KEYS.pending },
  { value: "confirmed", labelKey: PAYMENT_STATUS_LABEL_KEYS.confirmed },
  { value: "failed", labelKey: PAYMENT_STATUS_LABEL_KEYS.failed },
  { value: "reversed", labelKey: PAYMENT_STATUS_LABEL_KEYS.reversed },
];

const MODE_OPTION_KEYS: { value: PaymentMode | ""; labelKey: string }[] = [
  { value: "", labelKey: "finance.payments.list.allMethods" },
  { value: "cash", labelKey: PAYMENT_MODE_LABEL_KEYS.cash },
  { value: "bank_transfer", labelKey: PAYMENT_MODE_LABEL_KEYS.bank_transfer },
  { value: "card_external", labelKey: PAYMENT_MODE_LABEL_KEYS.card_external },
];

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Payment history (`/portal/finance/payments`), gated by `billing:read`. Filter by status, method,
 * payment date and a search (payment or invoice number, student name or admission number); the
 * confirmed total of everything matching sits above the list, which is the cash-up and bank-match
 * figure. A confirmed row can be asked to be reversed (`billing:update`, approved by a school admin
 * in the refunds queue). A confirmed row's receipt opens straight from here, which is what makes a reprint just a
 * click rather than a new lookup — issuance already happened once, from `RecordPaymentPage`'s own
 * success state.
 *
 * Each row names the student and links to their family's page, where finance sees the whole
 * household and can take one payment across all its children's invoices.
 * Offset-paginated to match the endpoint's own `limit`/`offset` contract — see `fetchPaymentsPage`'s
 * doc comment for why this isn't `@studafy/ui`'s cursor-shaped `useCursorPagination`.
 */
export default function PaymentsListPage() {
  const { t } = useTranslation();
  const canRequestReversal = usePermissions().has(PERMISSIONS.BILLING_UPDATE);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PaymentStatus | "">("");
  const [mode, setMode] = useState<PaymentMode | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [reverseTarget, setReverseTarget] = useState<PaymentListItem | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const filters: PaymentFilters = { status, mode, dateFrom, dateTo, search };

  const query = useQuery({
    queryKey: ["finance", "payments", "list", status, mode, dateFrom, dateTo, search, offset],
    queryFn: () => fetchPaymentsPage(filters, offset),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totals = query.data?.totals ?? [];
  const hasPreviousPage = offset > 0;
  const hasNextPage = offset + items.length < total;

  function changeStatus(next: PaymentStatus | "") {
    setStatus(next);
    setOffset(0);
  }

  function changeFilter<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setOffset(0);
    };
  }

  const modeOptions: SelectOption<PaymentMode | "">[] = MODE_OPTION_KEYS.map(
    ({ value, labelKey }) => ({ value, label: t(labelKey) }),
  );

  const statusOptions: SelectOption<PaymentStatus | "">[] = STATUS_OPTION_KEYS.map(
    ({ value, labelKey }) => ({ value, label: t(labelKey) }),
  );

  const columns: DataGridColumn<PaymentListItem>[] = [
    { id: "payment_date", header: t("finance.common.date"), renderCell: (row) => row.payment_date },
    {
      id: "student",
      header: t("finance.common.student"),
      renderCell: (row) =>
        row.student_name ? (
          <Link to={`/portal/finance/students/${row.student_id}`}>{row.student_name}</Link>
        ) : (
          "—"
        ),
    },
    {
      id: "family",
      header: t("finance.common.family"),
      renderCell: (row) =>
        row.family_id ? (
          <Link to={`/portal/finance/families/${row.family_id}`}>{row.family_name}</Link>
        ) : (
          "—"
        ),
    },
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
      renderCell: (row) => (row.receipt_url ? <ReceiptButton paymentId={row.id} /> : "—"),
    },
    ...(canRequestReversal
      ? [
          {
            id: "actions",
            header: t("finance.payments.list.actions"),
            renderCell: (row: PaymentListItem) =>
              row.status === "confirmed" && row.erpnext_invoice_id ? (
                <Button type="button" variant="tertiary" onClick={() => setReverseTarget(row)}>
                  {t("finance.payments.list.reverse")}
                </Button>
              ) : null,
          },
        ]
      : []),
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
        <Input
          type="search"
          label={t("finance.payments.list.search")}
          placeholder={t("finance.payments.list.searchPlaceholder")}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <Select
          label={t("finance.common.status")}
          options={statusOptions}
          value={status}
          onChange={changeStatus}
        />
        <Select
          label={t("finance.common.method")}
          options={modeOptions}
          value={mode}
          onChange={changeFilter(setMode)}
        />
        <Input
          type="date"
          label={t("finance.payments.list.dateFrom")}
          value={dateFrom}
          max={dateTo || undefined}
          onChange={(event) => changeFilter(setDateFrom)(event.target.value)}
        />
        <Input
          type="date"
          label={t("finance.payments.list.dateTo")}
          value={dateTo}
          min={dateFrom || undefined}
          onChange={(event) => changeFilter(setDateTo)(event.target.value)}
        />
      </div>

      <p className="payments-list__totals" role="status">
        {totals.length === 0
          ? // Only worth saying when the list is empty too; with (pending) rows below it misleads.
            items.length === 0 && !query.isPending
            ? t("finance.payments.list.noConfirmedTotal")
            : null
          : totals
              .map((sum) =>
                t("finance.payments.list.confirmedTotal", {
                  amount: sum.amount,
                  currency: sum.currency,
                  count: sum.count,
                }),
              )
              .join(" · ")}
      </p>

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

      <CorrectionRequestModal
        key={reverseTarget?.id ?? "closed"}
        kind="payment_reversal"
        targetId={reverseTarget?.id ?? null}
        summary={
          reverseTarget
            ? `${reverseTarget.erpnext_payment_entry_id ?? ""} · ${reverseTarget.amount} ${reverseTarget.currency}`
            : ""
        }
        onClose={() => setReverseTarget(null)}
        onRequested={() => {
          setReverseTarget(null);
          void queryClient.invalidateQueries({ queryKey: ["finance", "adjustments", "refunds"] });
        }}
      />
    </>
  );
}
