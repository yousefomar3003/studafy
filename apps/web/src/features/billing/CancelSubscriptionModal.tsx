import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useId, useState } from "react";

import { useCancelSubscription } from "./mutations";

import type { FormEvent } from "react";

export interface CancelSubscriptionModalProps {
  open: boolean;
  currentPeriodEnd: string | undefined;
  onClose: () => void;
  onCancelled: () => void;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * Cancellation flow: schedules cancellation at the end of the current billing period rather than
 * cutting access off immediately (see `scheduleCancellation`'s doc comment in the API) — the reason
 * is optional and forwarded as-is. There is no retention offer step here: the product has no
 * discount or downgrade mechanism to offer, so `POST /cancel` is sent with `retentionOfferShown`
 * left unset rather than faking one.
 */
export function CancelSubscriptionModal({
  open,
  currentPeriodEnd,
  onClose,
  onCancelled,
}: CancelSubscriptionModalProps) {
  const { show } = useToast();
  const cancel = useCancelSubscription();
  const [reason, setReason] = useState("");
  const reasonId = useId();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    cancel.mutate(
      { reason: reason.trim() },
      {
        onSuccess: () => {
          show({ variant: "success", title: "Cancellation scheduled" });
          setReason("");
          onCancelled();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: "Couldn't cancel the subscription",
            description: apiErrorMessage(error, "Please try again."),
          }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cancel subscription?"
      description="This schedules cancellation for the end of the current billing period."
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          <p className="billing-cancel__notice">
            {currentPeriodEnd
              ? `Access and billing continue until ${formatDate(currentPeriodEnd)}. You can undo this at any time before then.`
              : "Access and billing continue until the end of the current period. You can undo this at any time before then."}
          </p>
          <div className="sf-field">
            <label className="sf-field__label" htmlFor={reasonId}>
              Reason (optional)
            </label>
            <div className="sf-input">
              <textarea
                id={reasonId}
                className="sf-input__control"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            Keep subscription
          </Button>
          <Button type="submit" variant="primary" loading={cancel.isPending}>
            Cancel subscription
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
