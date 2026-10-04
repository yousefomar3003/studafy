import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Select } from "@studafy/ui";
import { useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";

import { AdjustmentConfirmDialog } from "./AdjustmentConfirmDialog";
import { REASON_CODE_LABEL_KEYS } from "./labels";
import { useInitiateRefund } from "./mutations";
import { formatMinorAmount, invoicePaidAmountMinor } from "./queries";
import { RefundInvoicePickerField } from "./RefundInvoicePickerField";

import "./adjustments.css";

import type { ReasonCode, Refund } from "./queries";
import type { Invoice } from "../invoices/queries";
import type { SelectOption } from "@studafy/ui";
import type { TFunction } from "i18next";
import type { FormEvent } from "react";

function apiErrorMessage(error: unknown, fallback: string, t: TFunction): string {
  if (!(error instanceof ApiError)) return fallback;
  // Mirrors `payments/RecordPaymentPage`'s own 409 case: reusing this Idempotency-Key with a
  // different body means an earlier submission may already have gone through.
  if (error.status === 409) {
    return t("financeReports.adjustments.newRefund.conflictError");
  }
  return error.detail ?? error.title;
}

/**
 * Refund, maker step (`/portal/finance/adjustments/refunds/new`), gated by `billing:update`. Same
 * state-machine shape as `payments/RecordPaymentPage`: the form, then a confirmation dialog showing
 * the exact amount before it commits, then the created refund's own pending-approval state — this
 * page only ever produces the maker half of the pair (see `initiateRefund`'s doc comment in the API).
 *
 * The refund amount is capped in the UI at the selected invoice's paid-to-date amount
 * (`invoicePaidAmountMinor`) — the same cap ERPNext itself enforces when a checker approves (see
 * `approveRefund`'s doc comment) — so an over-refund is rejected here before it is ever submitted,
 * not just after a round trip to ERPNext.
 */
export default function NewRefundPage() {
  const { t } = useTranslation();
  const [refund, setRefund] = useState<Refund | null>(null);

  return (
    <>
      <p className="adjustments-form__back">
        <Link to="/portal/finance/adjustments/refunds">
          {t("financeReports.adjustments.newRefund.back")}
        </Link>
      </p>
      <h1>{t("financeReports.adjustments.newRefund.title")}</h1>

      {refund ? (
        <RefundCreated refund={refund} onReset={() => setRefund(null)} />
      ) : (
        <RefundForm onCreated={setRefund} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface RefundFormProps {
  onCreated: (refund: Refund) => void;
}

function RefundForm({ onCreated }: RefundFormProps) {
  const { t } = useTranslation();
  const initiateRefund = useInitiateRefund();
  const reasonNotesId = useId();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [reasonCode, setReasonCode] = useState<ReasonCode | "">("");
  const [reasonNotes, setReasonNotes] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Same lifetime rules as `RecordPaymentPage`'s own refs: one idempotency key per submission
  // attempt (not per click), and a synchronous guard against a double-click racing ahead of
  // `isPending`'s next render.
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const submittingRef = useRef(false);

  const amountValue = Number(amountInput);
  const isValidAmount =
    amountInput.trim() !== "" && Number.isFinite(amountValue) && amountValue > 0;
  const paidAmountMinor = invoice ? invoicePaidAmountMinor(invoice) : 0;
  const amountMinor =
    isValidAmount && invoice ? Math.round(amountValue * 10 ** invoice.currency_minor_unit) : 0;
  const exceedsPaidAmount = isValidAmount && invoice !== null && amountMinor > paidAmountMinor;

  const reasonOptions: SelectOption<ReasonCode | "">[] = [
    { value: "", label: t("financeReports.adjustments.newRefund.selectReason") },
    ...(Object.entries(REASON_CODE_LABEL_KEYS) as [ReasonCode, string][]).map(
      ([value, labelKey]) => ({ value, label: t(labelKey) }),
    ),
  ];

  const canSubmit = invoice !== null && isValidAmount && !exceedsPaidAmount && reasonCode !== "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setConfirmOpen(true);
  }

  function handleConfirm() {
    if (!invoice || !canSubmit || submittingRef.current) return;
    submittingRef.current = true;

    initiateRefund.mutate(
      {
        body: {
          student_id: invoice.student_id,
          erpnext_invoice_id: invoice.erpnext_docname,
          amount: amountValue,
          currency: invoice.currency,
          reason_code: reasonCode as ReasonCode,
          reason_notes: reasonNotes.trim() || undefined,
        },
        idempotencyKey: idempotencyKeyRef.current,
      },
      {
        onSuccess: (created) => {
          setConfirmOpen(false);
          onCreated(created);
        },
        onError: () => {
          submittingRef.current = false;
        },
      },
    );
  }

  return (
    <>
      <Card as="section" aria-label={t("financeReports.adjustments.newRefund.formLabel")}>
        <Card.Body>
          <form onSubmit={handleSubmit} className="adjustments-form">
            <RefundInvoicePickerField value={invoice} onChange={setInvoice} />

            <Input
              label={t("financeReports.adjustments.common.amount")}
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
                className="adjustments-form__math"
                role="status"
                data-tone={exceedsPaidAmount ? "danger" : "neutral"}
              >
                {exceedsPaidAmount
                  ? t("financeReports.adjustments.newRefund.exceedsPaid", {
                      amount: formatMinorAmount(paidAmountMinor, invoice.currency_minor_unit),
                      currency: invoice.currency,
                    })
                  : t("financeReports.adjustments.newRefund.upTo", {
                      amount: formatMinorAmount(paidAmountMinor, invoice.currency_minor_unit),
                      currency: invoice.currency,
                    })}
              </p>
            ) : null}

            <Select
              label={t("financeReports.adjustments.common.reason")}
              options={reasonOptions}
              value={reasonCode}
              onChange={setReasonCode}
              disabled={!invoice}
            />

            <div className="sf-field">
              <label className="sf-field__label" htmlFor={reasonNotesId}>
                {t("financeReports.adjustments.newRefund.notesOptional")}
              </label>
              <div className="sf-input adjustments-reason-input">
                <textarea
                  id={reasonNotesId}
                  className="sf-input__control"
                  rows={3}
                  maxLength={1000}
                  value={reasonNotes}
                  onChange={(event) => setReasonNotes(event.target.value)}
                  disabled={!invoice}
                />
              </div>
            </div>

            <div className="adjustments-form__actions">
              <Button type="submit" disabled={!canSubmit}>
                {t("financeReports.adjustments.newRefund.reviewRefund")}
              </Button>
            </div>
          </form>
        </Card.Body>
      </Card>

      <AdjustmentConfirmDialog
        open={confirmOpen}
        title={t("financeReports.adjustments.newRefund.confirmTitle")}
        description={t("financeReports.adjustments.newRefund.confirmDescription")}
        confirmLabel={t("financeReports.adjustments.newRefund.confirmLabel")}
        loading={initiateRefund.isPending}
        error={
          initiateRefund.isError
            ? apiErrorMessage(
                initiateRefund.error,
                t("financeReports.adjustments.newRefund.requestError"),
                t,
              )
            : undefined
        }
        onConfirm={handleConfirm}
        onClose={() => setConfirmOpen(false)}
      >
        {invoice ? (
          <dl className="adjustments-effect">
            <div>
              <dt>{t("financeReports.adjustments.common.student")}</dt>
              <dd>
                {invoice.student_name} &middot; {invoice.admission_number}
              </dd>
            </div>
            <div>
              <dt>{t("financeReports.adjustments.common.invoice")}</dt>
              <dd>{invoice.erpnext_docname}</dd>
            </div>
            <div>
              <dt>{t("financeReports.adjustments.common.refundAmount")}</dt>
              <dd>
                {formatMinorAmount(amountMinor, invoice.currency_minor_unit)} {invoice.currency}
              </dd>
            </div>
            <div>
              <dt>{t("financeReports.adjustments.common.paidToDate")}</dt>
              <dd>
                {formatMinorAmount(paidAmountMinor, invoice.currency_minor_unit)} {invoice.currency}
              </dd>
            </div>
            <div>
              <dt>{t("financeReports.adjustments.common.reason")}</dt>
              <dd>{reasonCode ? t(REASON_CODE_LABEL_KEYS[reasonCode]) : "—"}</dd>
            </div>
          </dl>
        ) : null}
      </AdjustmentConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

interface RefundCreatedProps {
  refund: Refund;
  onReset: () => void;
}

function RefundCreated({ refund, onReset }: RefundCreatedProps) {
  const { t } = useTranslation();
  return (
    <Card as="section" aria-label={t("financeReports.adjustments.newRefund.createdLabel")}>
      <Card.Body>
        <p role="status" className="adjustments-success__headline">
          {t("financeReports.adjustments.newRefund.createdHeadline", {
            amount: refund.amount,
            currency: refund.currency,
          })}
        </p>
        <p>{t("financeReports.adjustments.newRefund.createdBody")}</p>

        <div className="adjustments-success__actions">
          <Button type="button" variant="secondary" onClick={onReset}>
            {t("financeReports.adjustments.newRefund.requestAnother")}
          </Button>
          <Link to="/portal/finance/adjustments/refunds">
            {t("financeReports.adjustments.newRefund.viewRefunds")}
          </Link>
        </div>
      </Card.Body>
    </Card>
  );
}
