import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Radio, RadioGroup, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { fetchInvoice, invoiceQueryKey } from "../invoices/queries";
import { PAYMENT_MODE_LABELS, PAYMENT_STATUS_LABELS, paymentStatusTone } from "../labels";

import { InvoicePickerField } from "./InvoicePickerField";
import { useCreatePayment } from "./mutations";
import { fetchPayment, paymentQueryKey } from "./queries";

import "./payments.css";

import type { Invoice } from "../invoices/queries";
import type { Payment } from "../queries";
import type { CreatePaymentBody, PaymentMode } from "./queries";
import type { FormEvent } from "react";

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  // A 409 here means this exact idempotency key already produced a *different* payment — most
  // likely an earlier submission actually went through and this retry silently changed the body
  // (see `idempotencyMiddleware`'s doc comment in the API). Pointing at the list is safer than
  // inviting a second attempt that could genuinely double-record.
  if (error.status === 409) {
    return "This submission may have already been recorded with different details. Check the payment history before retrying.";
  }
  return error.detail ?? error.title;
}

function formatMinorAmount(minor: number, minorUnit: number): string {
  return (minor / 10 ** minorUnit).toFixed(minorUnit);
}

/**
 * Payment recording (`/portal/finance/payments/new`), gated by `billing:update`. A small state
 * machine on the same principle as `invoices/InvoiceBatchPage`: the form, then the recorded
 * payment's own success/confirmation state once `useCreatePayment` returns.
 *
 * `?invoiceId=` preselects the invoice (the `Link` `InvoiceDetailPage` renders passes its own
 * `invoice.id`) — plain lookup-by-search still works with no query param at all.
 */
export default function RecordPaymentPage() {
  const [payment, setPayment] = useState<Payment | null>(null);

  return (
    <>
      <p className="payments-form__back">
        <Link to="/portal/finance/payments">&larr; Back to payments</Link>
      </p>
      <h1>Record a payment</h1>

      {payment ? (
        <PaymentSuccess payment={payment} onReset={() => setPayment(null)} />
      ) : (
        <PaymentForm onRecorded={setPayment} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface PaymentFormProps {
  onRecorded: (payment: Payment) => void;
}

function PaymentForm({ onRecorded }: PaymentFormProps) {
  const { show } = useToast();
  const createPayment = useCreatePayment();
  const [searchParams] = useSearchParams();
  const preselectInvoiceId = searchParams.get("invoiceId");

  // `undefined` = "the deep-link preload result (if any) still stands"; `null`/an `Invoice` once the
  // picker has been used explicitly. Keeps a deep-linked invoice from reappearing after the user
  // deliberately clears it, without an effect to reconcile the two sources.
  const [manualInvoice, setManualInvoice] = useState<Invoice | null | undefined>(undefined);

  const preloadQuery = useQuery({
    queryKey: invoiceQueryKey(preselectInvoiceId ?? "none"),
    queryFn: () => fetchInvoice(preselectInvoiceId as string),
    enabled: Boolean(preselectInvoiceId) && manualInvoice === undefined,
  });

  const invoice: Invoice | null =
    manualInvoice !== undefined ? manualInvoice : (preloadQuery.data ?? null);

  const [amountInput, setAmountInput] = useState("");
  const [mode, setMode] = useState<PaymentMode | "">("");
  const [referenceNo, setReferenceNo] = useState("");
  const [referenceDate, setReferenceDate] = useState("");
  const [postingDate, setPostingDate] = useState("");
  const [remarks, setRemarks] = useState("");

  // One key per submission *attempt*, not per click — a double-click must replay onto the same
  // key so the server's idempotency store (not just this component) is what ultimately guarantees
  // one Payment Entry. Regenerated only when a fresh `PaymentForm` mounts, i.e. after "Record
  // another payment" unmounts this one — see `RecordPaymentPage`.
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  // Synchronous guard against a double-click firing two submits before React re-renders the
  // disabled button — `createPayment.isPending` alone lags one render behind the second click.
  const submittingRef = useRef(false);

  const amountValue = Number(amountInput);
  const isValidAmount =
    amountInput.trim() !== "" && Number.isFinite(amountValue) && amountValue > 0;
  const amountMinor =
    isValidAmount && invoice ? Math.round(amountValue * 10 ** invoice.currency_minor_unit) : 0;
  const exceedsOutstanding =
    isValidAmount && invoice !== null && amountMinor > invoice.outstanding_amount_minor;
  const remainingMinor = invoice ? invoice.outstanding_amount_minor - amountMinor : 0;

  const requiresReference = mode !== "" && mode !== "cash";

  // Only what the gateway itself requires to accept the request (a resolvable student, a target
  // invoice, a positive amount, a mode it can map — see `createPaymentBodySchema`'s doc comment).
  // Exceeding the outstanding balance is deliberately *not* in this list: that is ERPNext's rule to
  // enforce, not a second opinion re-implemented here, so it is surfaced as a warning below rather
  // than blocking submit.
  const canSubmit = invoice !== null && isValidAmount && mode !== "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !invoice || submittingRef.current) return;
    submittingRef.current = true;

    const body: CreatePaymentBody = {
      student_id: invoice.student_id,
      invoice_id: invoice.erpnext_docname,
      amount: amountValue,
      payment_mode: mode as PaymentMode,
      currency: invoice.currency,
      reference_no: referenceNo.trim() || undefined,
      reference_date: referenceDate || undefined,
      posting_date: postingDate || undefined,
      remarks: remarks.trim() || undefined,
    };

    createPayment.mutate(
      { body, idempotencyKey: idempotencyKeyRef.current },
      {
        onSuccess: onRecorded,
        onError: (error) => {
          submittingRef.current = false;
          show({
            variant: "error",
            title: "Couldn't record the payment",
            description: apiErrorMessage(error, "Please check the form and try again."),
          });
        },
      },
    );
  }

  return (
    <Card as="section" aria-label="Payment form">
      <Card.Body>
        <form onSubmit={handleSubmit} className="payments-form">
          <InvoicePickerField value={invoice} onChange={setManualInvoice} />

          <Input
            label="Amount"
            type="text"
            inputMode="decimal"
            value={amountInput}
            onChange={(event) => setAmountInput(event.target.value)}
            suffix={invoice?.currency}
            placeholder="0.00"
            disabled={!invoice}
            required
          />

          {invoice && isValidAmount ? (
            <p
              className="payments-form__math"
              role="status"
              data-tone={exceedsOutstanding ? "warning" : "neutral"}
            >
              {exceedsOutstanding
                ? `This exceeds the invoice's outstanding balance of ${invoice.outstanding_amount} ${invoice.currency}. ERPNext will reject an overpayment.`
                : remainingMinor === 0
                  ? "Full payment — this invoice will be fully settled."
                  : `Partial payment — ${formatMinorAmount(remainingMinor, invoice.currency_minor_unit)} ${invoice.currency} will remain outstanding.`}
            </p>
          ) : null}

          {/* No `required` here: `@studafy/ui`'s `RadioGroup` renders it as `aria-required` on the
              `<fieldset>`, which axe flags (`aria-allowed-attr`) since ARIA doesn't permit
              `aria-required` on a group role. `canSubmit` below already gates on `mode !== ""`,
              so the requirement is still enforced — just not restated in markup that would fail. */}
          <RadioGroup
            label="Payment method"
            name="payment-mode"
            value={mode}
            onChange={(value) => setMode(value as PaymentMode)}
          >
            {(Object.entries(PAYMENT_MODE_LABELS) as [PaymentMode, string][]).map(
              ([value, label]) => (
                <Radio key={value} value={value} label={label} />
              ),
            )}
          </RadioGroup>

          <Input
            label="Reference number"
            type="text"
            value={referenceNo}
            onChange={(event) => setReferenceNo(event.target.value)}
            maxLength={140}
            helperText={
              requiresReference
                ? "Required by ERPNext for bank transfer and card payments."
                : "Bank or terminal reference, if any."
            }
          />

          <Input
            label="Reference date (optional)"
            type="date"
            value={referenceDate}
            onChange={(event) => setReferenceDate(event.target.value)}
          />

          <Input
            label="Posting date (optional)"
            type="date"
            value={postingDate}
            onChange={(event) => setPostingDate(event.target.value)}
            helperText="Defaults to today."
          />

          <Input
            label="Remarks (optional)"
            type="text"
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            maxLength={500}
          />

          <div className="payments-form__actions">
            <Button type="submit" loading={createPayment.isPending} disabled={!canSubmit}>
              Record payment
            </Button>
          </div>
        </form>
      </Card.Body>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Success / receipt
// ---------------------------------------------------------------------------

interface PaymentSuccessProps {
  payment: Payment;
  onReset: () => void;
}

const CONFIRMING_STATUSES = new Set<Payment["status"]>(["pending"]);
const POLL_INTERVAL_MS = 3000;

/**
 * The payment just created is `status: "pending"` on the wire — ERPNext confirms it and supplies
 * `receipt_url` asynchronously via webhook (see `createPaymentBodySchema`'s doc comment). This
 * polls the same way `InvoiceBatchPage`'s `BatchProgress` polls a running batch: every 3s while
 * still pending, stopping once ERPNext confirms or rejects it.
 */
function PaymentSuccess({ payment: created, onReset }: PaymentSuccessProps) {
  const query = useQuery({
    queryKey: paymentQueryKey(created.id),
    queryFn: () => fetchPayment(created.id),
    initialData: created,
    refetchInterval: (activeQuery) =>
      activeQuery.state.data && CONFIRMING_STATUSES.has(activeQuery.state.data.status)
        ? POLL_INTERVAL_MS
        : false,
  });

  const payment = query.data ?? created;

  return (
    <Card as="section" aria-label="Payment recorded">
      <Card.Body>
        <p role="status" className="payments-success__headline">
          Payment recorded &mdash; {payment.amount} {payment.currency}
        </p>

        <dl className="payments-success__summary">
          <div>
            <dt>Invoice</dt>
            <dd>{payment.erpnext_invoice_id ?? "—"}</dd>
          </div>
          <div>
            <dt>Method</dt>
            <dd>{payment.payment_mode ? PAYMENT_MODE_LABELS[payment.payment_mode] : "—"}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{payment.payment_date}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className="payments-status-pill" data-tone={paymentStatusTone(payment.status)}>
                {PAYMENT_STATUS_LABELS[payment.status]}
              </span>
            </dd>
          </div>
        </dl>

        {payment.status === "pending" ? (
          <p>Awaiting confirmation from ERPNext. The receipt will appear here once confirmed.</p>
        ) : payment.status === "failed" ? (
          <p role="alert">
            ERPNext ultimately rejected this payment. Check the payment history for details.
          </p>
        ) : payment.receipt_url ? (
          <a
            className="sf-button sf-button--primary"
            href={payment.receipt_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open receipt
          </a>
        ) : null}

        <div className="payments-success__actions">
          <Button type="button" variant="secondary" onClick={onReset}>
            Record another payment
          </Button>
          <Link to="/portal/finance/payments">View payment history</Link>
        </div>
      </Card.Body>
    </Card>
  );
}
