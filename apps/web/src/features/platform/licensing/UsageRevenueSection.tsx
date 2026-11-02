import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { useMoney } from "./format";
import { useConsoleFeaturesQuery, useUsageRevenueQuery } from "./queries";

import "./licensing.css";

/**
 * Paid-feature usage this month, per feature and per school, next to each school's license revenue
 * and AI provider cost (from the AI metrics above). The token ledger records cost per school, not per
 * feature, so cost is shown per school only.
 */
export function UsageRevenueSection({
  aiCostUsdBySchool,
}: {
  aiCostUsdBySchool: ReadonlyMap<string, number>;
}) {
  const { t } = useTranslation();
  const { formatCurrency, formatNumber } = useFormatters();
  const money = useMoney();
  const usage = useUsageRevenueQuery();
  const features = useConsoleFeaturesQuery();
  const metered = (features.data ?? []).filter((feature) => feature.unit !== null);
  const schools = usage.data?.schools ?? [];
  const total = (key: string) =>
    schools.reduce(
      (sum, school) => sum + (school.usage.find((u) => u.feature === key)?.used ?? 0),
      0,
    );

  return (
    <section aria-labelledby="usage-revenue" className="platform-stack">
      <h2 id="usage-revenue">{t("platformLicensing.usage.title")}</h2>
      <p className="platform-muted">{t("platformLicensing.usage.description")}</p>
      {usage.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {usage.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}

      {usage.data ? (
        <>
          <div className="platform-stats">
            {metered.map((feature) => (
              <div className="platform-stat" key={feature.key}>
                <span className="platform-stat__label">{feature.displayName}</span>
                <span className="platform-stat__value">
                  {t("platformLicensing.usage.units", {
                    used: formatNumber(total(feature.key)),
                    unit: t(`platformLicensing.unit.${feature.unit}`),
                  })}
                </span>
              </div>
            ))}
          </div>

          {schools.length === 0 ? (
            <p className="platform-muted">{t("platformLicensing.usage.empty")}</p>
          ) : (
            <table className="platform-table">
              <caption className="sf-visually-hidden">
                {t("platformLicensing.usage.caption")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("platformLicensing.usage.columns.school")}</th>
                  {metered.map((feature) => (
                    <th scope="col" key={feature.key}>
                      {feature.displayName}
                    </th>
                  ))}
                  <th scope="col">{t("platformLicensing.usage.columns.aiCost")}</th>
                  <th scope="col">{t("platformLicensing.usage.columns.revenueMonth")}</th>
                  <th scope="col">{t("platformLicensing.usage.columns.revenueTotal")}</th>
                </tr>
              </thead>
              <tbody>
                {schools.map((school) => {
                  const cost = aiCostUsdBySchool.get(school.schoolId);
                  return (
                    <tr key={school.schoolId}>
                      <td>
                        <Link to={`/portal/platform/schools/${school.schoolId}`}>
                          {school.schoolName}
                        </Link>
                      </td>
                      {metered.map((feature) => (
                        <td key={feature.key} className="licensing-amount">
                          {formatNumber(
                            school.usage.find((u) => u.feature === feature.key)?.used ?? 0,
                          )}
                        </td>
                      ))}
                      <td className="licensing-amount">
                        {cost === undefined ? "—" : formatCurrency(cost, "USD")}
                      </td>
                      <td className="licensing-amount">
                        {school.revenue.length === 0
                          ? "—"
                          : school.revenue
                              .map((r) => money(r.thisMonthMinor, r.currencyCode, r.minorUnit))
                              .join(" · ")}
                      </td>
                      <td className="licensing-amount">
                        {school.revenue.length === 0
                          ? "—"
                          : school.revenue
                              .map((r) => money(r.totalMinor, r.currencyCode, r.minorUnit))
                              .join(" · ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </section>
  );
}
