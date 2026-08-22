import { Button, DataGrid, useCursorPagination } from "@studafy/ui";
import { Link } from "react-router-dom";

import { fetchInvoicesPage } from "./queries";

import "./billing.css";

import type { BillingInvoice } from "./queries";
import type { DataGridColumn } from "@studafy/ui";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

function formatAmount(amountMinor: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    }).format(amountMinor / 100);
  } catch {
    // An unrecognized ISO currency code would throw inside Intl.NumberFormat — same fallback
    // `PricingPage.tsx` uses rather than letting the page crash on bad reference data.
    return `${(amountMinor / 100).toFixed(2)} ${currencyCode}`;
  }
}

/**
 * Invoice history (`/portal/billing/invoices`), gated by `organization:manageBilling` like the rest
 * of `/portal/billing`. Reads straight from the payment provider — Studafy keeps no local copy of
 * its own plan invoices (see `listSchoolInvoices`'s doc comment in the API) — so this is Stripe's
 * cursor-forward pagination (`starting_after`/`has_more`), adapted for `useCursorPagination` the same
 * way `finance/invoices/InvoiceListPage` adapts its own cursor contract.
 */
export default function BillingInvoicesPage() {
  const { items, loading, error, hasNextPage, hasPreviousPage, goToNextPage, goToPreviousPage } =
    useCursorPagination(fetchInvoicesPage);

  const columns: DataGridColumn<BillingInvoice>[] = [
    { id: "created", header: "Date", renderCell: (row) => formatDate(row.created) },
    {
      id: "period",
      header: "Period",
      renderCell: (row) => `${formatDate(row.periodStart)} – ${formatDate(row.periodEnd)}`,
    },
    { id: "status", header: "Status", renderCell: (row) => row.status ?? "—" },
    {
      id: "amountDue",
      header: "Amount due",
      align: "end",
      renderCell: (row) => formatAmount(row.amountDue, row.currency),
    },
    {
      id: "amountPaid",
      header: "Amount paid",
      align: "end",
      renderCell: (row) => formatAmount(row.amountPaid, row.currency),
    },
    {
      id: "links",
      header: "Documents",
      renderCell: (row) => (
        <>
          {row.hostedInvoiceUrl ? (
            <a href={row.hostedInvoiceUrl} target="_blank" rel="noreferrer">
              View
            </a>
          ) : null}
          {row.hostedInvoiceUrl && row.invoicePdf ? " · " : null}
          {row.invoicePdf ? (
            <a href={row.invoicePdf} target="_blank" rel="noreferrer">
              PDF
            </a>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <>
      <p className="billing-overview__caption">
        <Link to="/portal/billing">&larr; Back to billing</Link>
      </p>

      <div className="billing-invoices__header">
        <h1>Invoices</h1>
        <p>Billing history from the payment provider, most recent first.</p>
      </div>

      <DataGrid
        caption="Invoices"
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.id}
        loading={loading}
        empty={error ? "Unable to load invoices." : "No invoices yet."}
      />

      <div className="billing-invoices__pagination">
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
