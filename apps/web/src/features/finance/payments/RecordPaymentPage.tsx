import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Radio, RadioGroup, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { fetchInvoice, invoiceQueryKey } from "../invoices/queries";
import { PAYMENT_MODE_LABEL_KEYS, PAYMENT_STATUS_LABEL_KEYS, paymentStatusTone } from "../labels";

import { InvoicePickerField } from "./InvoicePickerField";
import { useCreatePayment } from "./mutations";
import { fetchPayment, paymentQueryKey } from "./queries";

import "./payments.css";

import type { Invoice } from "../invoices/queries";
import type { Payment } from "../queries";
import type { CreatePaymentBody, PaymentMode } from "./queries";
import type { TFunction } from "i18next";
import type { FormEvent } from "react";

function apiErrorMessage(error: unknown, fallback: string, t: TFunction): string {
  if (!(error instanceof ApiError)) return fallback;
  // A 409 here means this exact idempotency key already produced a *different* payment — most
  // likely an earlier submission actually went through and this retry silently changed the body
  // (see `idempotencyMiddleware`'s doc comment in the API). Pointing at the list is safer than
  // inviting a second attempt that could genuinely double-record.
  if (error.status === 409) {
    return t("finance.payments.record.conflict");
  }
  return error.detail ?? error.title;
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
  const { t } = useTranslation();
  const [payment, setPayment] = useState<Payment | null>(null);

  return (
    <>
      <p className="payments-form__back">
        <Link to="/portal/finance/payments">{t("finance.payments.record.back")}</Link>
      </p>
      <h1>{t("finance.payments.record.title")}</h1>

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
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
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
            title: t("finance.payments.record.error"),
            description: apiErrorMessage(error, t("finance.common.checkFormAndRetry"), t),
          });
        },
      },
    );
  }

  return (
    <Card as="section" aria-label={t("finance.payments.record.formLabel")}>
      <Card.Body>
        <form onSubmit={handleSubmit} className="payments-form">
          <InvoicePickerField value={invoice} onChange={setManualInvoice} />

          <Input
            label={t("finance.common.amount")}
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
                ? t("finance.payments.record.exceeds", {
                    amount: invoice.outstanding_amount,
                    currency: invoice.currency,
                  })
                : remainingMinor === 0
                  ? t("finance.payments.record.full")
                  : t("finance.payments.record.partial", {
                      amount: formatNumber(remainingMinor / 10 ** invoice.currency_minor_unit, {
                        minimumFractionDigits: invoice.currency_minor_unit,
                        maximumFractionDigits: invoice.currency_minor_unit,
                        useGrouping: false,
                      }),
                      currency: invoice.currency,
                    })}
            </p>
          ) : null}

          {/* No `required` here: `@studafy/ui`'s `RadioGroup` renders it as `aria-required` on the
              `<fieldset>`, which axe flags (`aria-allowed-attr`) since ARIA doesn't permit
              `aria-required` on a group role. `canSubmit` below already gates on `mode !== ""`,
              so the requirement is still enforced — just not restated in markup that would fail. */}
          <RadioGroup
            label={t("finance.payments.record.method")}
            name="payment-mode"
            value={mode}
            onChange={(value) => setMode(value as PaymentMode)}
          >
            {(Object.entries(PAYMENT_MODE_LABEL_KEYS) as [PaymentMode, string][]).map(
              ([value, labelKey]) => (
                <Radio key={value} value={value} label={t(labelKey)} />
              ),
            )}
          </RadioGroup>

          <Input
            label={t("finance.payments.record.referenceNumber")}
            type="text"
            value={referenceNo}
            onChange={(event) => setReferenceNo(event.target.value)}
            maxLength={140}
            helperText={
              requiresReference
                ? t("finance.payments.record.referenceRequired")
                : t("finance.payments.record.referenceOptional")
            }
          />

          <Input
            label={t("finance.payments.record.referenceDate")}
            type="date"
            value={referenceDate}
            onChange={(event) => setReferenceDate(event.target.value)}
          />

          <Input
            label={t("finance.payments.record.postingDate")}
            type="date"
            value={postingDate}
            onChange={(event) => setPostingDate(event.target.value)}
            helperText={t("finance.common.defaultsToToday")}
          />

          <Input
            label={t("finance.payments.record.remarks")}
            type="text"
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            maxLength={500}
          />

          <div className="payments-form__actions">
            <Button type="submit" loading={createPayment.isPending} disabled={!canSubmit}>
              {t("finance.common.recordPayment")}
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
  const { t } = useTranslation();
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
    <Card as="section" aria-label={t("finance.payments.record.recordedLabel")}>
      <Card.Body>
        <p role="status" className="payments-success__headline">
          {t("finance.payments.record.recordedHeadline", {
            amount: payment.amount,
            currency: payment.currency,
          })}
        </p>

        <dl className="payments-success__summary">
          <div>
            <dt>{t("finance.common.invoice")}</dt>
            <dd>{payment.erpnext_invoice_id ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("finance.common.method")}</dt>
            <dd>{payment.payment_mode ? t(PAYMENT_MODE_LABEL_KEYS[payment.payment_mode]) : "—"}</dd>
          </div>
          <div>
            <dt>{t("finance.common.date")}</dt>
            <dd>{payment.payment_date}</dd>
          </div>
          <div>
            <dt>{t("finance.common.status")}</dt>
            <dd>
              <span className="payments-status-pill" data-tone={paymentStatusTone(payment.status)}>
                {t(PAYMENT_STATUS_LABEL_KEYS[payment.status])}
              </span>
            </dd>
          </div>
        </dl>

        {payment.status === "pending" ? (
          <p>{t("finance.payments.record.awaiting")}</p>
        ) : payment.status === "failed" ? (
          <p role="alert">{t("finance.payments.record.rejected")}</p>
        ) : payment.receipt_url ? (
          <a
            className="sf-button sf-button--primary"
            href={payment.receipt_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("finance.common.openReceipt")}
          </a>
        ) : null}

        <div className="payments-success__actions">
          <Button type="button" variant="secondary" onClick={onReset}>
            {t("finance.payments.record.recordAnother")}
          </Button>
          <Link to="/portal/finance/payments">{t("finance.payments.record.viewHistory")}</Link>
        </div>
      </Card.Body>
    </Card>
  );
}
