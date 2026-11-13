import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useId, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useRequestInvoiceCancellation, useRequestPaymentReversal } from "./mutations";

import type { Refund } from "./queries";
import type { FormEvent } from "react";

export type CorrectionKind = "invoice_cancellation" | "payment_reversal";

export interface CorrectionRequestModalProps {
  kind: CorrectionKind;
  /** The invoice or payment id; null keeps the modal closed. */
  targetId: string | null;
  /** What is being corrected, for the description: an invoice or payment number and amount. */
  summary: string;
  onClose: () => void;
  onRequested: (request: Refund) => void;
}

const KEYS: Record<CorrectionKind, string> = {
  invoice_cancellation: "financeReports.adjustments.corrections.cancelInvoice",
  payment_reversal: "financeReports.adjustments.corrections.reversePayment",
};

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * The maker step for cancelling an invoice or reversing a payment: a required reason, then a
 * pending request in the refunds queue that a school admin approves. Nothing changes in ERPNext
 * until then, which the description says. Remount with `key` per target, as `RejectRefundModal`.
 */
export function CorrectionRequestModal({
  kind,
  targetId,
  summary,
  onClose,
  onRequested,
}: CorrectionRequestModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const cancellation = useRequestInvoiceCancellation();
  const reversal = useRequestPaymentReversal();
  const mutation = kind === "invoice_cancellation" ? cancellation : reversal;
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const reasonId = useId();
  const errorId = `${reasonId}-error`;
  const trimmed = reason.trim();
  const invalid = touched && trimmed === "";
  const base = KEYS[kind];

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (trimmed === "" || !targetId) return;
    mutation.mutate(
      { id: targetId, reasonNotes: trimmed },
      {
        onSuccess: (request) => {
          show({ variant: "success", title: t(`${base}.requestedToast`) });
          onRequested(request);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t(`${base}.error`),
            description: apiErrorDescription(error),
          }),
      },
    );
  }

  return (
    <Modal
      open={targetId !== null}
      onClose={onClose}
      title={t(`${base}.title`)}
      description={t(`${base}.description`, { summary })}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          <div className="sf-field">
            <label className="sf-field__label" htmlFor={reasonId}>
              {t("financeReports.adjustments.corrections.reason")}
              <span className="sf-field__required" aria-hidden="true">
                *
              </span>
            </label>
            <div className="sf-input adjustments-reason-input">
              <textarea
                id={reasonId}
                className="sf-input__control"
                rows={3}
                required
                autoFocus
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={invalid ? errorId : undefined}
              />
            </div>
            {invalid ? (
              <p className="sf-field__error" id={errorId} role="alert">
                {t("financeReports.adjustments.corrections.reasonRequired")}
              </p>
            ) : null}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("financeReports.adjustments.common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {t(`${base}.submit`)}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
