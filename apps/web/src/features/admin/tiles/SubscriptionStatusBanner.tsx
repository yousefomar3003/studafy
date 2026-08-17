import { DashboardTile } from "../../../components/DashboardTile";
import { useBillingOverviewQuery } from "../billing-overview-query";

// Maps (not plain objects) so a subscription status string can never resolve a prototype member —
// the same reasoning apps/api's authz.ts documents for its own status-keyed lookup.
const STATUS_LABEL = new Map<string, string>([
  ["trialing", "Trialing"],
  ["active", "Active"],
  ["past_due", "Past due"],
  ["grace_period", "Grace period"],
  ["canceled", "Canceled"],
  ["expired", "Expired"],
  ["closed", "Closed"],
  ["paused", "Paused"],
]);

const STATUS_TONE = new Map<string, "success" | "warning" | "danger">([
  ["trialing", "success"],
  ["active", "success"],
  ["past_due", "warning"],
  ["grace_period", "warning"],
  ["paused", "warning"],
  ["canceled", "danger"],
  ["expired", "danger"],
  ["closed", "danger"],
]);

/** Current plan, lifecycle status, and seat usage — one call, shared with `StorageUsageTile`. */
export function SubscriptionStatusBanner() {
  const { data, isPending, isError } = useBillingOverviewQuery();

  const status = data?.subscription.status;
  const tone = (status && STATUS_TONE.get(status)) || "warning";
  const label = (status && STATUS_LABEL.get(status)) || status || "Unknown";

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
