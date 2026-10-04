import { DashboardTile } from "../../../components/DashboardTile";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { subscriptionStatusTone } from "../../billing/labels";
import { useBillingOverviewQuery } from "../../billing/queries";

/** Current plan, lifecycle status, and seat usage — one call, shared with `StorageUsageTile`. */
export function SubscriptionStatusBanner() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { data, isPending, isError } = useBillingOverviewQuery();

  const status = data?.subscription.status;
  const tone = status ? subscriptionStatusTone(status) : "warning";
  // An unrecognised lifecycle status falls back to the raw API value, as `subscriptionStatusLabel` does.
  const label = status
    ? t(`adminSchool.tiles.subscription.status.${status}`, { defaultValue: status })
    : t("adminSchool.tiles.subscription.unknown");

  return (
    <DashboardTile
      title={t("adminSchool.tiles.subscription.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("adminSchool.tiles.subscription.error")}
    >
      <p className="dashboard-tile__status-pill" data-tone={tone}>
        {label}
      </p>
      {data ? (
        <p className="dashboard-tile__caption">
          {t(
            data.subscription.cancelAtPeriodEnd
              ? "adminSchool.tiles.subscription.seatsCancelling"
              : "adminSchool.tiles.subscription.seats",
            {
              plan: data.plan.displayName,
              used: formatNumber(data.seats.used),
              cap: formatNumber(data.seats.cap),
            },
          )}
        </p>
      ) : null}
    </DashboardTile>
  );
}
