import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useId, useState } from "react";

import { useLocale, useTranslation } from "../../lib/i18n";

import { formatIsoDate } from "./format";
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
  const { t } = useTranslation();
  const { locale } = useLocale();
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
          show({ variant: "success", title: t("site.billing.cancelModal.scheduledToast") });
          setReason("");
          onCancelled();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("site.billing.cancelModal.errorToast"),
            description: apiErrorMessage(error, t("site.common.tryAgain")),
          }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("site.billing.cancelModal.title")}
      description={t("site.billing.cancelModal.description")}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          <p className="billing-cancel__notice">
            {currentPeriodEnd
              ? t("site.billing.cancelModal.noticeWithDate", {
                  date: formatIsoDate(currentPeriodEnd, locale),
                })
              : t("site.billing.cancelModal.notice")}
          </p>
          <div className="sf-field">
            <label className="sf-field__label" htmlFor={reasonId}>
              {t("site.billing.cancelModal.reasonLabel")}
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
            {t("site.billing.cancelModal.keepSubscription")}
          </Button>
          <Button type="submit" variant="primary" loading={cancel.isPending}>
            {t("site.billing.cancelModal.confirm")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
