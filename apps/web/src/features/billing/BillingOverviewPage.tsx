import { ApiError } from "@studafy/api-client";
import { Button, Card, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { CancelSubscriptionModal } from "./CancelSubscriptionModal";
import { ChangePlanModal } from "./ChangePlanModal";
import { DunningBanner } from "./DunningBanner";
import { isEndedStatus, subscriptionStatusLabel, subscriptionStatusTone } from "./labels";
import { useOpenBillingPortal, useReverseSubscriptionCancellation } from "./mutations";
import { useBillingOverviewQuery } from "./queries";

import "./billing.css";

const SEATS_WARNING_FRACTION = 0.8;

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
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
          title: "Couldn't open the billing portal",
          description: apiErrorMessage(error, "Please try again."),
        }),
    });
  }

  function handleUndoCancel() {
    reverseCancel.mutate(undefined, {
      onSuccess: () => show({ variant: "success", title: "Cancellation undone" }),
      onError: (error) =>
        show({
          variant: "error",
          title: "Couldn't undo the cancellation",
          description: apiErrorMessage(error, "Please try again."),
        }),
    });
  }

  return (
    <>
      <h1>Billing</h1>
      <p>Plan, seats, payment method, invoice history, and subscription cancellation.</p>

      {overviewQuery.isError ? (
        <p className="billing-overview__notice" role="alert">
          Unable to load billing details. Try reloading the page.
        </p>
      ) : null}

      {overviewQuery.isPending ? (
        <p role="status">Loading…</p>
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
                <p className="billing-banner__title">Your subscription has ended</p>
                <p className="billing-banner__body">
                  Choose a plan to restore access for your school.
                </p>
              </div>
              <Button type="button" variant="primary" onClick={() => setChangePlanOpen(true)}>
                Choose a plan
              </Button>
            </div>
          ) : null}

          <div className="billing-overview__grid">
            <Card as="section" aria-label="Plan and seats">
              <Card.Header>
                <h2>Plan</h2>
              </Card.Header>
              <Card.Body>
                <p
                  className="billing-status-pill"
                  data-tone={subscriptionStatusTone(overview.subscription.status)}
                >
                  {subscriptionStatusLabel(overview.subscription.status)}
                </p>

                <dl className="billing-overview__stat-list">
                  <div className="billing-overview__stat">
                    <dt>Plan</dt>
                    <dd>{overview.plan.displayName}</dd>
                  </div>
                  <div className="billing-overview__stat">
                    <dt>Seats</dt>
                    <dd>
                      {overview.seats.used}/{overview.seats.cap}
                    </dd>
                  </div>
                </dl>

                <SeatsMeter used={overview.seats.used} cap={overview.seats.cap} />

                <p className="billing-overview__caption">
                  Current period: {formatDate(overview.subscription.currentPeriodStart)} –{" "}
                  {formatDate(overview.subscription.currentPeriodEnd)}
                </p>

                {overview.subscription.cancelAtPeriodEnd ? (
                  <p className="billing-overview__notice" role="status">
                    Cancellation scheduled — access ends{" "}
                    {formatDate(overview.subscription.currentPeriodEnd)}.
                  </p>
                ) : null}

                <div className="billing-overview__actions">
                  <Button type="button" variant="secondary" onClick={() => setChangePlanOpen(true)}>
                    Change plan
                  </Button>
                  {overview.subscription.cancelAtPeriodEnd ? (
                    <Button
                      type="button"
                      variant="secondary"
                      loading={reverseCancel.isPending}
                      onClick={handleUndoCancel}
                    >
                      Keep subscription
                    </Button>
                  ) : !isEndedStatus(overview.subscription.status) ? (
                    <Button type="button" variant="tertiary" onClick={() => setCancelOpen(true)}>
                      Cancel subscription
                    </Button>
                  ) : null}
                </div>
              </Card.Body>
            </Card>

            <Card as="section" aria-label="Payment method and invoices">
              <Card.Header>
                <h2>Payment and invoices</h2>
              </Card.Header>
              <Card.Body>
                <p className="billing-overview__caption">
                  Manage the payment method, tax details, and past receipts on file in the payment
                  provider&rsquo;s own portal. Studafy does not store card details.
                </p>
                <div className="billing-overview__actions">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={openPortal.isPending}
                    onClick={handleOpenPortal}
                  >
                    Manage payment method
                  </Button>
                  <Link to="/portal/billing/invoices">
                    <Button type="button" variant="tertiary">
                      View invoice history
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
  const hasCap = cap > 0;
  const percent = hasCap ? Math.round((used / cap) * 100) : 0;
  const tone =
    percent >= 100 ? "danger" : percent >= SEATS_WARNING_FRACTION * 100 ? "warning" : "success";

  return (
    <div
      className="billing-meter"
      role="img"
      aria-label={hasCap ? `${percent}% of seats used` : "Seat cap not configured"}
    >
      <div
        className="billing-meter-fill"
        data-tone={tone}
        style={{ width: `${hasCap ? Math.min(percent, 100) : 0}%` }}
      />
    </div>
  );
}
