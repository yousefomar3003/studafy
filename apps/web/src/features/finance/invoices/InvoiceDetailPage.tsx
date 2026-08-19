import { Button, Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

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
    return <p role="status">Loading…</p>;
  }

  if (query.isError) {
    return (
      <>
        <p className="invoices-detail__back invoices-detail__no-print">
          <Link to="/portal/finance/invoices">&larr; Back to invoices</Link>
        </p>
        <p role="alert">Couldn't load this invoice. Please try again.</p>
      </>
    );
  }

  const invoice = query.data;

  return (
    <div className="invoices-detail">
      <p className="invoices-detail__back invoices-detail__no-print">
        <Link to="/portal/finance/invoices">&larr; Back to invoices</Link>
      </p>

      <div className="invoices-detail__header">
        <div>
          <h1>Invoice {invoice.erpnext_docname}</h1>
          <p>
            {invoice.student_name} &middot; {invoice.admission_number}
          </p>
        </div>
        <div className="invoices-detail__header-actions invoices-detail__no-print">
          <span
            className="invoices-status-pill"
            data-tone={invoiceStatusTone(invoice.erpnext_status)}
          >
            {invoiceStatusLabel(invoice.erpnext_status)}
          </span>
          <Button type="button" variant="secondary" onClick={handlePrint}>
            Print / Save as PDF
          </Button>
        </div>
      </div>

      <Card as="section" aria-label="Invoice summary">
        <Card.Body>
          <dl className="invoices-detail__summary">
            <div>
              <dt>Issued</dt>
              <dd>{invoice.issued_date}</dd>
            </div>
            <div>
              <dt>Due</dt>
              <dd>{invoice.due_date ?? "—"}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>
                {invoice.total_amount} {invoice.currency}
              </dd>
            </div>
            <div>
              <dt>Outstanding</dt>
              <dd>
                {invoice.outstanding_amount} {invoice.currency}
              </dd>
            </div>
          </dl>
        </Card.Body>
      </Card>

      <section aria-label="Invoice lines" className="invoices-detail__lines">
        <h2>Lines</h2>
        {invoice.lines.length === 0 ? (
          <p className="invoices-detail__lines-empty">No line items on this invoice.</p>
        ) : (
          <table className="invoices-detail__lines-table">
            <caption className="sf-visually-hidden">Invoice lines</caption>
            <thead>
              <tr>
                <th scope="col">Fee category</th>
                <th scope="col">Description</th>
                <th scope="col">Qty</th>
                <th scope="col">Amount</th>
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
                  Total
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
