import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import { useMissingSummaryQuery } from "./queries";

import "./missing.css";

/**
 * The principal dashboard's missing-information tile: how many current students and parents have a
 * missing required field or document, and how many documents have expired or expire within 30
 * days. Rendered only for sessions holding `studentRecord:read` (the caller passes the check, so
 * the query never runs without it).
 */
export function MissingRecordsTile() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { data, isPending, isError } = useMissingSummaryQuery(true);
  const people = (data?.students ?? 0) + (data?.parents ?? 0);

  return (
    <DashboardTile
      title={t("recordTemplates.tile.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("recordTemplates.tile.error")}
    >
      {people === 0 &&
      (data?.expired_documents ?? 0) === 0 &&
      (data?.expiring_documents ?? 0) === 0 ? (
        <p className="dashboard-tile__caption">{t("recordTemplates.tile.empty")}</p>
      ) : (
        <ul className="records-missing__issues">
          <li>
            {t("recordTemplates.tile.students", {
              count: data?.students ?? 0,
              formatted: formatNumber(data?.students ?? 0),
            })}
          </li>
          <li>
            {t("recordTemplates.tile.parents", {
              count: data?.parents ?? 0,
              formatted: formatNumber(data?.parents ?? 0),
            })}
          </li>
          <li>
            {t("recordTemplates.tile.expired", {
              count: data?.expired_documents ?? 0,
              formatted: formatNumber(data?.expired_documents ?? 0),
            })}
          </li>
          <li>
            {t("recordTemplates.tile.expiring", {
              count: data?.expiring_documents ?? 0,
              formatted: formatNumber(data?.expiring_documents ?? 0),
            })}
          </li>
        </ul>
      )}
      <Link className="dashboard-tile__link" to="/portal/principal/records/missing">
        {t("recordTemplates.tile.link")}
      </Link>
    </DashboardTile>
  );
}
