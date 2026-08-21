import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useId, useState } from "react";

import { useRejectRefund } from "./mutations";

import type { Refund } from "./queries";
import type { FormEvent } from "react";

export interface RejectRefundModalProps {
  refund: Refund | null;
  onClose: () => void;
  onRejected: (refund: Refund) => void;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * Reason-required reject confirmation for the refund checker step, same shape as
 * `principal/approvals/RejectReasonModal` — `rejectRefundBodySchema` requires non-empty
 * `reason_notes` server-side, and this enforces the same requirement client-side rather than
 * round-tripping to discover it. Remount with `key={refund?.id ?? "closed"}` from the caller so
 * leftover text from a previous refund never bleeds into the next one, matching that component's
 * own remount note.
 */
export function RejectRefundModal({ refund, onClose, onRejected }: RejectRefundModalProps) {
  const { show } = useToast();
  const reject = useRejectRefund();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const reasonId = useId();
  const errorId = `${reasonId}-error`;
  const trimmedReason = reason.trim();
  const invalid = touched && trimmedReason === "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (trimmedReason === "" || !refund) return;

    reject.mutate(
      { refundId: refund.id, reasonNotes: trimmedReason },
      {
        onSuccess: (rejected) => {
          show({ variant: "success", title: "Refund rejected" });
          onRejected(rejected);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: "Couldn't reject refund",
            description: apiErrorDescription(error),
          }),
      },
    );
  }

  return (
    <Modal
      open={refund !== null}
      onClose={onClose}
      title="Reject refund"
      description={
        refund
          ? `${refund.amount} ${refund.currency} against ${refund.erpnext_invoice_id}`
          : undefined
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          <div className="sf-field">
            <label className="sf-field__label" htmlFor={reasonId}>
              Reason
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
                A reason is required to reject.
              </p>
            ) : null}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={reject.isPending}>
            Reject
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
