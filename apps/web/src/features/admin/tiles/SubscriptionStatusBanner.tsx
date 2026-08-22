import { DashboardTile } from "../../../components/DashboardTile";
import { subscriptionStatusLabel, subscriptionStatusTone } from "../../billing/labels";
import { useBillingOverviewQuery } from "../../billing/queries";

/** Current plan, lifecycle status, and seat usage — one call, shared with `StorageUsageTile`. */
export function SubscriptionStatusBanner() {
  const { data, isPending, isError } = useBillingOverviewQuery();

  const status = data?.subscription.status;
  const tone = status ? subscriptionStatusTone(status) : "warning";
  const label = status ? subscriptionStatusLabel(status) : "Unknown";

  return (
    <DashboardTile
      title="Subscription"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load subscription status."
    >
      <p className="dashboard-tile__status-pill" data-tone={tone}>
        {label}
      </p>
      {data ? (
        <p className="dashboard-tile__caption">
          {data.plan.displayName} · {data.seats.used}/{data.seats.cap} seats
          {data.subscription.cancelAtPeriodEnd ? " · cancels at period end" : ""}
        </p>
      ) : null}
    </DashboardTile>
  );
}
