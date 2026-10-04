import { DashboardTile } from "../../../components/DashboardTile";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useBillingOverviewQuery } from "../../billing/queries";

import type { Formatters } from "../../../lib/i18n";
import type { TFunction } from "i18next";

/** Matches STORAGE_QUOTA_WARNING_THRESHOLD in apps/api's storage/quota-service.ts. */
const STORAGE_WARNING_THRESHOLD = 0.8;
const STORAGE_DANGER_THRESHOLD = 0.95;

/** One decimal place, no digit grouping — "1000.0 MB", matching the tile's original fixed-point
 * output, while still rendering the active locale's digits and decimal separator. */
const ONE_DECIMAL: Intl.NumberFormatOptions = {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  useGrouping: false,
};

function formatBytes(
  bytes: number,
  t: TFunction,
  formatNumber: Formatters["formatNumber"],
): string {
  if (bytes >= 1024 ** 3) {
    return t("adminSchool.tiles.storage.units.gb", {
      value: formatNumber(bytes / 1024 ** 3, ONE_DECIMAL),
    });
  }
  if (bytes >= 1024 ** 2) {
    return t("adminSchool.tiles.storage.units.mb", {
      value: formatNumber(bytes / 1024 ** 2, ONE_DECIMAL),
    });
  }
  if (bytes >= 1024) {
    return t("adminSchool.tiles.storage.units.kb", {
      value: formatNumber(bytes / 1024, ONE_DECIMAL),
    });
  }
  return t("adminSchool.tiles.storage.units.b", {
    value: formatNumber(bytes, { useGrouping: false }),
  });
}

/** Storage usage against the plan's cap — one call, shared with `SubscriptionStatusBanner`. */
export function StorageUsageTile() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
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
      title={t("adminSchool.tiles.storage.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("adminSchool.tiles.storage.error")}
    >
      {!storage ? (
        <p className="dashboard-tile__caption">{t("adminSchool.tiles.storage.empty")}</p>
      ) : (
        <>
          <div
            className="dashboard-tile__meter"
            role="img"
            aria-label={
              hasCap
                ? t("adminSchool.tiles.storage.meterLabel", {
                    percent: formatNumber(percent / 100, { style: "percent" }),
                  })
                : t("adminSchool.tiles.storage.noCap")
            }
          >
            <div
              className="dashboard-tile__meter-fill"
              data-tone={tone}
              style={{ width: `${hasCap ? Math.min(percent, 100) : 0}%` }}
            />
          </div>
          <p className="dashboard-tile__caption">
            {hasCap
              ? t("adminSchool.tiles.storage.usedOfCap", {
                  used: formatBytes(storage.usedBytes, t, formatNumber),
                  cap: formatBytes(storage.capBytes, t, formatNumber),
                })
              : t("adminSchool.tiles.storage.usedNoCap", {
                  used: formatBytes(storage.usedBytes, t, formatNumber),
                })}
          </p>
        </>
      )}
    </DashboardTile>
  );
}
