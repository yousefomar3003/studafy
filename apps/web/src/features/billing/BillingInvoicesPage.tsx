import { Button, DataGrid, useCursorPagination } from "@studafy/ui";
import { Link } from "react-router-dom";

import { useLocale, useTranslation } from "../../lib/i18n";

import { formatIsoDate, formatMinorAmount } from "./format";
import { fetchInvoicesPage } from "./queries";

import "./billing.css";

import type { BillingInvoice } from "./queries";
import type { DataGridColumn } from "@studafy/ui";

/** Translation keys for Stripe's invoice statuses; an unknown status renders as-is. */
const INVOICE_STATUS_KEY = new Map<string, string>([
  ["draft", "site.billing.invoices.status.draft"],
  ["open", "site.billing.invoices.status.open"],
  ["paid", "site.billing.invoices.status.paid"],
  ["uncollectible", "site.billing.invoices.status.uncollectible"],
  ["void", "site.billing.invoices.status.void"],
]);

/**
 * Invoice history (`/portal/billing/invoices`), gated by `organization:manageBilling` like the rest
 * of `/portal/billing`. Reads straight from the payment provider — Studafy keeps no local copy of
 * its own plan invoices (see `listSchoolInvoices`'s doc comment in the API) — so this is Stripe's
 * cursor-forward pagination (`starting_after`/`has_more`), adapted for `useCursorPagination` the same
 * way `finance/invoices/InvoiceListPage` adapts its own cursor contract.
 */
export default function BillingInvoicesPage() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const formatDate = (iso: string) => formatIsoDate(iso, locale);
  const statusLabel = (status: string) => {
    const key = INVOICE_STATUS_KEY.get(status);
    return key ? t(key) : status;
  };
  const { items, loading, error, hasNextPage, hasPreviousPage, goToNextPage, goToPreviousPage } =
    useCursorPagination(fetchInvoicesPage);

  const columns: DataGridColumn<BillingInvoice>[] = [
    {
      id: "created",
      header: t("site.billing.invoices.columns.date"),
      renderCell: (row) => formatDate(row.created),
    },
    {
      id: "period",
      header: t("site.billing.invoices.columns.period"),
      renderCell: (row) =>
        t("site.billing.invoices.periodRange", {
          start: formatDate(row.periodStart),
          end: formatDate(row.periodEnd),
        }),
    },
    {
      id: "status",
      header: t("site.billing.invoices.columns.status"),
      renderCell: (row) => (row.status ? statusLabel(row.status) : "—"),
    },
    {
      id: "amountDue",
      header: t("site.billing.invoices.columns.amountDue"),
      align: "end",
      renderCell: (row) => formatMinorAmount(row.amountDue, row.currency, locale),
    },
    {
      id: "amountPaid",
      header: t("site.billing.invoices.columns.amountPaid"),
      align: "end",
      renderCell: (row) => formatMinorAmount(row.amountPaid, row.currency, locale),
    },
    {
      id: "links",
      header: t("site.billing.invoices.columns.documents"),
      renderCell: (row) => (
        <>
          {row.hostedInvoiceUrl ? (
            <a href={row.hostedInvoiceUrl} target="_blank" rel="noreferrer">
              {t("site.billing.invoices.view")}
            </a>
          ) : null}
          {row.hostedInvoiceUrl && row.invoicePdf ? " · " : null}
          {row.invoicePdf ? (
            <a href={row.invoicePdf} target="_blank" rel="noreferrer">
              {t("site.billing.invoices.pdf")}
            </a>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <>
      <p className="billing-overview__caption">
        <Link to="/portal/billing">{t("site.billing.invoices.back")}</Link>
      </p>

      <div className="billing-invoices__header">
        <h1>{t("site.billing.invoices.title")}</h1>
        <p>{t("site.billing.invoices.description")}</p>
      </div>

      <DataGrid
        caption={t("site.billing.invoices.caption")}
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.id}
        loading={loading}
        empty={error ? t("site.billing.invoices.loadError") : t("site.billing.invoices.empty")}
      />

      <div className="billing-invoices__pagination">
        <Button variant="secondary" disabled={!hasPreviousPage} onClick={goToPreviousPage}>
          {t("site.common.previous")}
        </Button>
        <Button variant="secondary" disabled={!hasNextPage} onClick={goToNextPage}>
          {t("site.common.next")}
        </Button>
      </div>
    </>
  );
}
