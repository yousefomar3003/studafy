import { Link } from "react-router-dom";

import { DashboardTile } from "../../components/DashboardTile";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { useCurrencyMoney, usePercent } from "../ai-programme/components";
import { useSchoolProgrammeQuery } from "../ai-programme/queries";

import "../../components/dashboard-tile.css";

const P = "schoolLicense.programme.tile";

/**
 * Student AI on the admin and principal dashboards (shown to `aiRevenueShare:read`): conversion and
 * the tier it earns, what the next tier takes, and the school's earnings for the year; the way into
 * the results page.
 */
export function StudentAiProgrammeTile() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const pct = usePercent();
  const { data, isPending, isError } = useSchoolProgrammeQuery();
  const m = useCurrencyMoney(data?.currencyCode ?? "USD", data?.minorUnit ?? 2);
  const conversion = data?.conversion ?? null;

  return (
    <DashboardTile
      title={t(`${P}.title`)}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t(`${P}.error`)}
    >
      {!data || !conversion ? (
        <p className="dashboard-tile__caption">{t(`${P}.none`)}</p>
      ) : (
        <>
          <dl className="dashboard-tile__stat-list">
            <div className="dashboard-tile__stat">
              <dt>{t(`${P}.conversion`)}</dt>
              <dd>{pct(conversion.conversionBps)}</dd>
            </div>
            <div className="dashboard-tile__stat">
              <dt>{t(`${P}.tier`)}</dt>
              <dd>{pct(conversion.shareBps)}</dd>
            </div>
            <div className="dashboard-tile__stat">
              <dt>{t(`${P}.earnings`)}</dt>
              <dd>{m(data.earnings.totalMinor)}</dd>
            </div>
          </dl>
          <p className="dashboard-tile__caption">
            {t(`${P}.students`, {
              optedIn: formatNumber(data.students.optedIn),
              enrolled: formatNumber(data.students.enrolled),
            })}
          </p>
          {data.nextTier && data.nextTier.optInsNeeded > 0 ? (
            <p className="dashboard-tile__caption" data-testid="tile-next-tier">
              {t("schoolLicense.programme.next.add", {
                count: data.nextTier.optInsNeeded,
                seats: formatNumber(data.nextTier.optInsNeeded),
                share: pct(data.nextTier.shareBps),
              })}
            </p>
          ) : null}
        </>
      )}
      <Link className="dashboard-tile__link" to="/portal/license/student-ai/results">
        {t(`${P}.link`)}
      </Link>
    </DashboardTile>
  );
}
