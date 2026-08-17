import { DashboardTile } from "../../../components/DashboardTile";
import { useBillingOverviewQuery } from "../billing-overview-query";

/** Matches STORAGE_QUOTA_WARNING_THRESHOLD in apps/api's storage/quota-service.ts. */
const STORAGE_WARNING_THRESHOLD = 0.8;
const STORAGE_DANGER_THRESHOLD = 0.95;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Storage usage against the plan's cap — one call, shared with `SubscriptionStatusBanner`. */
export function StorageUsageTile() {
  const { data, isPending, isError } = useBillingOverviewQuery();

  const storage = data?.storage;
  // fractionUsed is NaN when no cap is configured (see BillingOverview schema) — that's a real
  // "we don't know" state, not zero usage, so it gets its own message rather than a fake 0% meter.
  const hasCap = storage !== undefined && Number.isFinite(storage.fractionUsed);
  const percent = hasCap ? Math.round(storage.fractionUsed * 100) : 0;
  const tone =
    percent >= STORAGE_DANGER_THRESHOLD * 100
      ? "danger"
      : percent >= STORAGE_WARNING_THRESHOLD * 100
        ? "warning"
        : "success";

  return (
    <DashboardTile
      title="Storage usage"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load storage usage."
    >
      {!storage ? (
        <p className="dashboard-tile__caption">No storage data available.</p>
      ) : (
        <>
          <div
            className="dashboard-tile__meter"
            role="img"
            aria-label={hasCap ? `${percent}% of storage used` : "Storage cap not configured"}
          >
            <div
              className="dashboard-tile__meter-fill"
              data-tone={tone}
              style={{ width: `${hasCap ? Math.min(percent, 100) : 0}%` }}
            />
          </div>
          <p className="dashboard-tile__caption">
            {hasCap
              ? `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.capBytes)} used`
              : `${formatBytes(storage.usedBytes)} used · no cap configured`}
          </p>
        </>
      )}
    </DashboardTile>
  );
}
