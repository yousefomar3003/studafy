import { ApiError } from "@studafy/api-client";
import { Button, Card, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useLocale, useTranslation } from "../../lib/i18n";
import { helpPath } from "../help/content";
import { HelpLink } from "../help/HelpLink";

import { CancelSubscriptionModal } from "./CancelSubscriptionModal";
import { ChangePlanModal } from "./ChangePlanModal";
import { DunningBanner } from "./DunningBanner";
import { formatIsoDate } from "./format";
import { isEndedStatus, subscriptionStatusLabel, subscriptionStatusTone } from "./labels";
import { useOpenBillingPortal, useReverseSubscriptionCancellation } from "./mutations";
import { useBillingOverviewQuery } from "./queries";

import "./billing.css";

const SEATS_WARNING_FRACTION = 0.8;

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/**
 * School billing home (`/portal/billing`), gated by `organization:manageBilling` — the same
 * permission every subscriptions route itself requires (see `billing-overview-routes.ts` and its
 * siblings). Plan and seat overview, the dunning banner for a failed or grace-period payment, the
 * checkout entry for changing plans, the link out to the payment provider's own portal, and the
 * cancellation flow all live on this one page; invoice history is its own page
 * (`BillingInvoicesPage`) since a receipt list can grow long.
 */
export default function BillingOverviewPage() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { show } = useToast();
  const overviewQuery = useBillingOverviewQuery();
  const openPortal = useOpenBillingPortal();
  const reverseCancel = useReverseSubscriptionCancellation();
  const [changePlanOpen, setChangePlanOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const overview = overviewQuery.data;

  function handleOpenPortal() {
    openPortal.mutate(undefined, {
      onSuccess: (result) => {
        window.location.assign(result.url);
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("site.billing.overview.portalError"),
          description: apiErrorMessage(error, t("site.common.tryAgain")),
        }),
    });
  }

  function handleUndoCancel() {
    reverseCancel.mutate(undefined, {
      onSuccess: () =>
        show({ variant: "success", title: t("site.billing.overview.cancellationUndone") }),
      onError: (error) =>
        show({
          variant: "error",
          title: t("site.billing.overview.undoError"),
          description: apiErrorMessage(error, t("site.common.tryAgain")),
        }),
    });
  }

  return (
    <>
      <h1>{t("site.billing.overview.title")}</h1>
      <p>{t("site.billing.overview.description")}</p>
      <p>
        <HelpLink to={helpPath("subscriptions")}>{t("help.readGuide")}</HelpLink>
      </p>

      {overviewQuery.isError ? (
        <p className="billing-overview__notice" role="alert">
          {t("site.billing.overview.loadError")}
        </p>
      ) : null}

      {overviewQuery.isPending ? (
        <p role="status">{t("site.common.loading")}</p>
      ) : overview ? (
        <>
          <DunningBanner
            subscription={overview.subscription}
            onManagePayment={handleOpenPortal}
            managingPayment={openPortal.isPending}
          />

          {isEndedStatus(overview.subscription.status) ? (
            <div className="billing-banner" data-tone="neutral" role="status">
              <div>
                <p className="billing-banner__title">{t("site.billing.overview.endedTitle")}</p>
                <p className="billing-banner__body">{t("site.billing.overview.endedBody")}</p>
              </div>
              <Button type="button" variant="primary" onClick={() => setChangePlanOpen(true)}>
                {t("site.billing.overview.choosePlan")}
              </Button>
            </div>
          ) : null}

          <div className="billing-overview__grid">
            <Card as="section" aria-label={t("site.billing.overview.planCardLabel")}>
              <Card.Header>
                <h2>{t("site.billing.overview.planHeading")}</h2>
              </Card.Header>
              <Card.Body>
                <p
                  className="billing-status-pill"
                  data-tone={subscriptionStatusTone(overview.subscription.status)}
                >
                  {subscriptionStatusLabel(overview.subscription.status, t)}
                </p>

                <dl className="billing-overview__stat-list">
                  <div className="billing-overview__stat">
                    <dt>{t("site.billing.overview.planLabel")}</dt>
                    <dd>{overview.plan.displayName}</dd>
                  </div>
                  <div className="billing-overview__stat">
                    <dt>{t("site.billing.overview.seatsLabel")}</dt>
                    <dd>
                      {overview.seats.used}/{overview.seats.cap}
                    </dd>
                  </div>
                </dl>

                <SeatsMeter used={overview.seats.used} cap={overview.seats.cap} />

                <p className="billing-overview__caption">
                  {t("site.billing.overview.currentPeriod", {
                    start: formatIsoDate(overview.subscription.currentPeriodStart, locale),
                    end: formatIsoDate(overview.subscription.currentPeriodEnd, locale),
                  })}
                </p>

                {overview.subscription.cancelAtPeriodEnd ? (
                  <p className="billing-overview__notice" role="status">
                    {t("site.billing.overview.cancellationScheduled", {
                      date: formatIsoDate(overview.subscription.currentPeriodEnd, locale),
                    })}
                  </p>
                ) : null}

                <div className="billing-overview__actions">
                  <Button type="button" variant="secondary" onClick={() => setChangePlanOpen(true)}>
                    {t("site.billing.overview.changePlan")}
                  </Button>
                  {overview.subscription.cancelAtPeriodEnd ? (
                    <Button
                      type="button"
                      variant="secondary"
                      loading={reverseCancel.isPending}
                      onClick={handleUndoCancel}
                    >
                      {t("site.billing.overview.keepSubscription")}
                    </Button>
                  ) : !isEndedStatus(overview.subscription.status) ? (
                    <Button type="button" variant="tertiary" onClick={() => setCancelOpen(true)}>
                      {t("site.billing.overview.cancelSubscription")}
                    </Button>
                  ) : null}
                </div>
              </Card.Body>
            </Card>

            <Card as="section" aria-label={t("site.billing.overview.paymentCardLabel")}>
              <Card.Header>
                <h2>{t("site.billing.overview.paymentHeading")}</h2>
              </Card.Header>
              <Card.Body>
                <p className="billing-overview__caption">
                  {t("site.billing.overview.paymentBody")}
                </p>
                <div className="billing-overview__actions">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={openPortal.isPending}
                    onClick={handleOpenPortal}
                  >
                    {t("site.billing.overview.managePayment")}
                  </Button>
                  <Link to="/portal/billing/invoices">
                    <Button type="button" variant="tertiary">
                      {t("site.billing.overview.viewInvoices")}
                    </Button>
                  </Link>
                </div>
              </Card.Body>
            </Card>
          </div>

          <ChangePlanModal
            open={changePlanOpen}
            currentPlanId={overview.plan.id}
            onClose={() => setChangePlanOpen(false)}
          />

          <CancelSubscriptionModal
            open={cancelOpen}
            currentPeriodEnd={overview.subscription.currentPeriodEnd}
            onClose={() => setCancelOpen(false)}
            onCancelled={() => setCancelOpen(false)}
          />
        </>
      ) : null}
    </>
  );
}

function SeatsMeter({ used, cap }: { used: number; cap: number }) {
  const { t } = useTranslation();
  const hasCap = cap > 0;
  const percent = hasCap ? Math.round((used / cap) * 100) : 0;
  const tone =
    percent >= 100 ? "danger" : percent >= SEATS_WARNING_FRACTION * 100 ? "warning" : "success";

  return (
    <div
      className="billing-meter"
      role="img"
      aria-label={
        hasCap
          ? t("site.billing.overview.seatsUsed", { percent })
          : t("site.billing.overview.seatCapMissing")
      }
    >
      <div
        className="billing-meter-fill"
        data-tone={tone}
        style={{ width: `${hasCap ? Math.min(percent, 100) : 0}%` }}
      />
    </div>
  );
}
