import { Link } from "react-router-dom";

import { DashboardTile } from "../../components/DashboardTile";
import { useFormatters, useTranslation } from "../../lib/i18n";

import { AUDIENCES, useSchoolLicenseQuery } from "./queries";

import "../../components/dashboard-tile.css";

/**
 * The school's license on the admin and principal dashboards (shown to `license:read`): its status,
 * seats used per audience and end date, and the way into `/portal/license`.
 */
export function LicenseTile() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const { data, isPending, isError } = useSchoolLicenseQuery();
  const license = data?.license ?? null;

  return (
    <DashboardTile
      title={t("schoolLicense.tile.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("schoolLicense.tile.error")}
    >
      {!license ? (
        <p className="dashboard-tile__caption">{t("schoolLicense.tile.none")}</p>
      ) : (
        <>
          <p className="dashboard-tile__caption">
            {t("schoolLicense.tile.status", {
              status: t(`schoolLicense.status.${license.status}`),
              date: formatDate(new Date(license.endsAt), { dateStyle: "medium" }),
            })}
          </p>
          <ul className="dashboard-tile__caption">
            {AUDIENCES.map((audience) => license.audiences.find((a) => a.audience === audience)!)
              .filter((row) => row && row.purchased > 0)
              .map((row) => (
                <li key={row.audience}>
                  {t("schoolLicense.tile.seats", {
                    audience: t(`schoolLicense.audience.${row.audience}`),
                    assigned: formatNumber(row.assigned),
                    purchased: formatNumber(row.purchased),
                  })}
                </li>
              ))}
          </ul>
        </>
      )}
      <Link className="dashboard-tile__link" to="/portal/license">
        {t("schoolLicense.tile.link")}
      </Link>
    </DashboardTile>
  );
}
