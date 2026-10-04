import { Button, Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";

import { invoiceStatusLabel, invoiceStatusTone } from "./labels";
import { fetchInvoice, invoiceQueryKey } from "./queries";

import "./invoices.css";

/**
 * Invoice detail (`/portal/finance/invoices/:invoiceId`), gated by `billing:read`. Line items are
 * parsed server-side from the cached ERPNext Sales Invoice document (see `getInvoiceDetail`'s doc
 * comment in the API's `service.ts`) — this page renders whatever comes back, it does not compute
 * totals itself.
 *
 * "Print / Save as PDF": there is no ERPNext-rendered PDF endpoint anywhere in this gateway to link
 * to or proxy, so the print view is this same markup under `@media print` in `invoices.css`, driven
 * by `window.print()`. That satisfies "detail matches PDF" by construction — printing produces a PDF
 * of the exact DOM the detail view shows — rather than by reproducing ERPNext's own print template.
 */
export default function InvoiceDetailPage() {
  const { t } = useTranslation();
  const { invoiceId } = useParams<{ invoiceId: string }>();

  const query = useQuery({
    queryKey: invoiceQueryKey(invoiceId ?? "none"),
    queryFn: () => fetchInvoice(invoiceId as string),
    enabled: Boolean(invoiceId),
  });

  function handlePrint() {
    if (!query.data) return;
    window.print();
  }

  if (query.isPending) {
    return <p role="status">{t("finance.common.loading")}</p>;
  }

  if (query.isError) {
    return (
      <>
        <p className="invoices-detail__back invoices-detail__no-print">
          <Link to="/portal/finance/invoices">{t("finance.invoices.backToInvoices")}</Link>
        </p>
        <p role="alert">{t("finance.invoices.detail.loadError")}</p>
      </>
    );
  }

  const invoice = query.data;
  // Not permission-gated client-side, same as `InvoiceListPage`'s "Generate invoices" link — the
  // route itself (`finance/payments/new`) is the actual `billing:update` boundary via
  // `RequirePermission`; this just decides whether a payment is even possible to record.
  const canRecordPayment =
    invoice.erpnext_status === "submitted" && invoice.outstanding_amount_minor > 0;

  return (
    <div className="invoices-detail">
      <p className="invoices-detail__back invoices-detail__no-print">
        <Link to="/portal/finance/invoices">{t("finance.invoices.backToInvoices")}</Link>
      </p>

      <div className="invoices-detail__header">
        <div>
          <h1>{t("finance.invoices.detail.title", { number: invoice.erpnext_docname })}</h1>
          <p>
            {invoice.student_name} &middot; {invoice.admission_number}
          </p>
        </div>
        <div className="invoices-detail__header-actions invoices-detail__no-print">
          <span
            className="invoices-status-pill"
            data-tone={invoiceStatusTone(invoice.erpnext_status)}
          >
            {invoiceStatusLabel(invoice.erpnext_status, t)}
          </span>
          {canRecordPayment ? (
            <Link to={`/portal/finance/payments/new?invoiceId=${invoice.id}`}>
              <Button type="button">{t("finance.common.recordPayment")}</Button>
            </Link>
          ) : null}
          <Button type="button" variant="secondary" onClick={handlePrint}>
            {t("finance.invoices.detail.print")}
          </Button>
        </div>
      </div>

      <Card as="section" aria-label={t("finance.invoices.detail.summary")}>
        <Card.Body>
          <dl className="invoices-detail__summary">
            <div>
              <dt>{t("finance.common.issued")}</dt>
              <dd>{invoice.issued_date}</dd>
            </div>
            <div>
              <dt>{t("finance.common.due")}</dt>
              <dd>{invoice.due_date ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("finance.common.total")}</dt>
              <dd>
                {invoice.total_amount} {invoice.currency}
              </dd>
            </div>
            <div>
              <dt>{t("finance.common.outstanding")}</dt>
              <dd>
                {invoice.outstanding_amount} {invoice.currency}
              </dd>
            </div>
          </dl>
        </Card.Body>
      </Card>

      <section
        aria-label={t("finance.invoices.detail.linesLabel")}
        className="invoices-detail__lines"
      >
        <h2>{t("finance.invoices.detail.lines")}</h2>
        {invoice.lines.length === 0 ? (
          <p className="invoices-detail__lines-empty">{t("finance.invoices.detail.noLines")}</p>
        ) : (
          <table className="invoices-detail__lines-table">
            <caption className="sf-visually-hidden">
              {t("finance.invoices.detail.linesLabel")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("finance.invoices.detail.feeCategory")}</th>
                <th scope="col">{t("finance.invoices.detail.lineDescription")}</th>
                <th scope="col">{t("finance.invoices.detail.quantity")}</th>
                <th scope="col">{t("finance.common.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, index) => (
                // Lines carry no id of their own — they are parsed positionally out of ERPNext's
                // own `items` array (see `getInvoiceDetail`), so position is the only stable key.
                <tr key={index}>
                  <td>{line.fee_category}</td>
                  <td>{line.description ?? "—"}</td>
                  <td>{line.quantity}</td>
                  <td>
                    {line.amount} {invoice.currency}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  {t("finance.common.total")}
                </th>
                <td>
                  {invoice.total_amount} {invoice.currency}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>
    </div>
  );
}
