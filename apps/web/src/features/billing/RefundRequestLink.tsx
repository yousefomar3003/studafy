import { ApiError } from "@studafy/api-client";
import { Button, Modal, Select, useToast } from "@studafy/ui";
import { useId, useState } from "react";

import { useLocale, useTranslation } from "../../lib/i18n";

import { formatIsoDate, formatMinorAmount } from "./format";
import { useCreateAiRefundRequest } from "./mutations";
import { useAiRefundRequestsQuery } from "./queries";

import type { SubscriptionRefundReason, SubscriptionRefundRequest } from "./queries";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const REASONS: readonly SubscriptionRefundReason[] = [
  "accidental_purchase",
  "duplicate_charge",
  "service_issue",
  "not_as_described",
  "no_longer_needed",
  "other",
];

/** Statuses a request is still being worked in: a second one cannot be filed meanwhile. */
const OPEN_STATUSES = new Set<SubscriptionRefundRequest["status"]>(["pending", "approved"]);

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

export interface RefundRequestLinkProps {
  /** The student whose AI add-on the request is about. */
  studentId: string;
}

/**
 * The "Request a refund" entry point: a plain text link that opens a small form, and the status of
 * the latest request once one exists. Deliberately quiet — it sits beside the active add-on it
 * belongs with rather than being promoted anywhere — but always present there, so a customer who
 * looks for it finds it. Studafy staff review every request in the platform console;
 * nothing is refunded until they approve it.
 */
export function RefundRequestLink({ studentId }: RefundRequestLinkProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <p className="billing-refund">
        <button type="button" className="billing-refund__link" onClick={() => setOpen(true)}>
          {t("site.billing.refund.link")}
        </button>
      </p>
      {open ? <RefundRequestModal studentId={studentId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function RefundRequestModal({
  studentId,
  onClose,
}: RefundRequestLinkProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const requestsQuery = useAiRefundRequestsQuery(true);
  const create = useCreateAiRefundRequest();
  const detailsId = useId();
  const [reason, setReason] = useState<SubscriptionRefundReason | "">("");
  const [details, setDetails] = useState("");
  const [reasonError, setReasonError] = useState(false);

  const latest = requestsQuery.data?.[0];
  const canFile = !latest || !OPEN_STATUSES.has(latest.status);

  const reasonOptions: SelectOption<SubscriptionRefundReason>[] = REASONS.map((value) => ({
    value,
    label: t(`site.billing.refund.reasons.${value}`),
  }));

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!reason) {
      setReasonError(true);
      return;
    }
    create.mutate(
      { studentId, reason, details: details.trim() },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("site.billing.refund.submittedToast") });
          setReason("");
          setDetails("");
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("site.billing.refund.errorToast"),
            description: apiErrorMessage(error, t("site.common.tryAgain")),
          }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("site.billing.refund.title")}
      description={t("site.billing.refund.description")}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          {requestsQuery.isPending ? (
            <p role="status">{t("site.common.loading")}</p>
          ) : latest ? (
            <RefundStatus request={latest} />
          ) : null}

          {requestsQuery.isPending ? null : canFile ? (
            <>
              <Select
                label={t("site.billing.refund.reasonLabel")}
                options={reasonOptions}
                value={reason || undefined}
                placeholder={t("site.billing.refund.reasonPlaceholder")}
                required
                error={reasonError ? t("site.billing.refund.reasonRequired") : undefined}
                onChange={(value) => {
                  setReason(value);
                  setReasonError(false);
                }}
              />
              <div className="sf-field">
                <label className="sf-field__label" htmlFor={detailsId}>
                  {t("site.billing.refund.detailsLabel")}
                </label>
                <div className="sf-input">
                  <textarea
                    id={detailsId}
                    className="sf-input__control"
                    rows={3}
                    maxLength={2000}
                    value={details}
                    onChange={(event) => setDetails(event.target.value)}
                  />
                </div>
              </div>
            </>
          ) : (
            <p className="billing-overview__caption">{t("site.billing.refund.openNotice")}</p>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("site.billing.refund.close")}
          </Button>
          {canFile && !requestsQuery.isPending ? (
            <Button type="submit" variant="primary" loading={create.isPending}>
              {t("site.billing.refund.submit")}
            </Button>
          ) : null}
        </Modal.Footer>
      </form>
    </Modal>
  );
}

/** The latest request: when it was sent, where it stands, and the reviewer's note if any. */
function RefundStatus({ request }: { request: SubscriptionRefundRequest }) {
  const { t } = useTranslation();
  const { locale } = useLocale();

  return (
    <div className="billing-refund__status" role="status">
      <p className="billing-refund__status-title">{t("site.billing.refund.statusHeading")}</p>
      <p className="billing-overview__caption">
        {t("site.billing.refund.statusLine", {
          date: formatIsoDate(request.createdAt, locale),
          status: t(`site.billing.refund.status.${request.status}`),
        })}
      </p>
      {request.refundedAmountMinor !== null && request.currencyCode ? (
        <p className="billing-overview__caption">
          {t("site.billing.refund.refundedAmount", {
            amount: formatMinorAmount(request.refundedAmountMinor, request.currencyCode, locale),
          })}
        </p>
      ) : null}
      {request.reviewNote ? (
        <p className="billing-overview__caption">
          {t("site.billing.refund.reviewNote", { note: request.reviewNote })}
        </p>
      ) : null}
    </div>
  );
}
