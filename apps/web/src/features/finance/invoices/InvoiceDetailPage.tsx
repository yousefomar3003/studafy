import { PERMISSIONS } from "@studafy/constants";
import { Button, Card } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";
import { CorrectionRequestModal } from "../adjustments/CorrectionRequestModal";
import { REFUND_KIND_LABEL_KEYS, REFUND_STATUS_LABEL_KEYS } from "../adjustments/labels";
import { fetchStudentRefunds } from "../adjustments/queries";

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
 *
 * Corrections (`billing:update`, each approved by a school admin in the refunds queue): cancel an
 * invoice nothing has been paid against, issue a credit note, or write off what is still owed. The
 * requests already made for this invoice are listed under it.
 */
export default function InvoiceDetailPage() {
  const { t } = useTranslation();
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const canCorrect = usePermissions().has(PERMISSIONS.BILLING_UPDATE);
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState(false);

  const query = useQuery({
    queryKey: invoiceQueryKey(invoiceId ?? "none"),
    queryFn: () => fetchInvoice(invoiceId as string),
    enabled: Boolean(invoiceId),
  });

  const studentId = query.data?.student_id;
  const corrections = useQuery({
    queryKey: ["finance", "adjustments", "refunds", "student", studentId],
    queryFn: () => fetchStudentRefunds(studentId as string),
    enabled: Boolean(studentId),
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
  const submitted = invoice.erpnext_status === "submitted";
  // Cancelling is only for an invoice nothing was paid against; the API also refuses one with a
  // pending payment or a credit note, which this page cannot see.
  const canCancel =
    canCorrect && submitted && invoice.outstanding_amount_minor === invoice.total_amount_minor;
  const canWriteOff = canCorrect && submitted && invoice.outstanding_amount_minor > 0;
  const invoiceCorrections = (corrections.data ?? []).filter(
    (request) => request.erpnext_invoice_id === invoice.erpnext_docname,
  );

  return (
    <div className="invoices-detail">
      <div className="invoices-detail__header">
        <div>
          <h1>{t("finance.invoices.detail.title", { number: invoice.erpnext_docname })}</h1>
          <p>
            <Link to={`/portal/finance/students/${invoice.student_id}`}>
              {invoice.student_name}
            </Link>{" "}
            &middot; {invoice.admission_number}
            {invoice.family_id ? (
              <>
                {" "}
                &middot;{" "}
                <Link to={`/portal/finance/families/${invoice.family_id}`}>
                  {invoice.family_name}
                </Link>
              </>
            ) : null}
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

      {canCorrect && submitted ? (
        <div className="invoices-detail__corrections invoices-detail__no-print">
          {canCancel ? (
            <Button type="button" variant="tertiary" onClick={() => setCancelling(true)}>
              {t("finance.invoices.detail.cancelInvoice")}
            </Button>
          ) : null}
          <Link
            to={`/portal/finance/adjustments/refunds/new?invoiceId=${invoice.id}&reason=error_correction`}
          >
            <Button type="button" variant="tertiary">
              {t("finance.invoices.detail.creditNote")}
            </Button>
          </Link>
          {canWriteOff ? (
            <Link
              to={`/portal/finance/adjustments/refunds/new?invoiceId=${invoice.id}&reason=write_off`}
            >
              <Button type="button" variant="tertiary">
                {t("finance.invoices.detail.writeOff")}
              </Button>
            </Link>
          ) : null}
        </div>
      ) : null}

      <Card as="section" aria-label={t("finance.invoices.detail.summary")}>
        <Card.Body>
          <dl className="invoices-detail__summary">
            {invoice.tax_registration_number ? (
              <div>
                <dt>{t("finance.invoices.detail.taxRegistration")}</dt>
                <dd>{invoice.tax_registration_number}</dd>
              </div>
            ) : null}
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
              {invoice.taxes.length > 0 && invoice.net_total !== null ? (
                <tr>
                  <th scope="row" colSpan={3}>
                    {t("finance.invoices.detail.netTotal")}
                  </th>
                  <td>
                    {invoice.net_total} {invoice.currency}
                  </td>
                </tr>
              ) : null}
              {invoice.taxes.map((tax, index) => (
                // Positional, like the lines: ERPNext's tax rows carry no id here.
                <tr key={`tax-${index}`}>
                  <th scope="row" colSpan={3}>
                    {tax.description}
                  </th>
                  <td>
                    {tax.amount} {invoice.currency}
                  </td>
                </tr>
              ))}
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

      {invoiceCorrections.length > 0 ? (
        <section
          aria-label={t("finance.invoices.detail.corrections")}
          className="invoices-detail__no-print"
        >
          <h2>{t("finance.invoices.detail.corrections")}</h2>
          <ul className="invoices-detail__correction-list">
            {invoiceCorrections.map((request) => (
              <li key={request.id}>
                <Link to={`/portal/finance/adjustments/refunds/${request.id}`}>
                  {t(REFUND_KIND_LABEL_KEYS[request.kind])}
                </Link>{" "}
                &middot; {request.amount} {request.currency} &middot;{" "}
                {t(REFUND_STATUS_LABEL_KEYS[request.status])}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <CorrectionRequestModal
        key={cancelling ? invoice.id : "closed"}
        kind="invoice_cancellation"
        targetId={cancelling ? invoice.id : null}
        summary={`${invoice.erpnext_docname} · ${invoice.total_amount} ${invoice.currency}`}
        onClose={() => setCancelling(false)}
        onRequested={() => {
          setCancelling(false);
          void queryClient.invalidateQueries({ queryKey: ["finance", "adjustments", "refunds"] });
        }}
      />
    </div>
  );
}
