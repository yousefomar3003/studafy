import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { useTranslation } from "../../../lib/i18n";
import {
  MESSAGE_REPORT_PRIORITY_LABEL_KEYS,
  MESSAGE_REPORT_REASON_LABEL_KEYS,
  priorityTone,
} from "../message-reports/labels";
import { useOpenMessageReportsPreviewQuery } from "../queries";

import "../message-reports/message-reports.css";

/**
 * Open (pending + in review) message reports, most pressing first — the server already orders by
 * priority and soonest `respond_by`. Rendered unconditionally on the principal dashboard: every role
 * holding `principalDashboard:view` (PRINCIPAL, ORG_ADMIN, SUPER_ADMIN) also holds
 * `messageReport:review`.
 */
export function OpenMessageReportsTile() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useOpenMessageReportsPreviewQuery();

  const total = data?.total ?? 0;
  const reports = data?.reports ?? [];

  return (
    <DashboardTile
      title={t("principal.tiles.openMessageReports.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("principal.tiles.openMessageReports.error")}
    >
      {total === 0 ? (
        <p className="dashboard-tile__caption">{t("principal.tiles.openMessageReports.empty")}</p>
      ) : null}

      {reports.length > 0 ? (
        <ul className="message-reports-tile__list">
          {reports.map((report) => (
            <li key={report.id} className="message-reports-tile__item">
              <span className="message-reports__pill" data-tone={priorityTone(report.priority)}>
                {t(MESSAGE_REPORT_PRIORITY_LABEL_KEYS[report.priority])}
              </span>
              {report.is_overdue ? (
                <span className="message-reports__pill" data-tone="danger">
                  {t("principal.messageReports.overdue")}
                </span>
              ) : null}
              <span>{t(MESSAGE_REPORT_REASON_LABEL_KEYS[report.reason_category])}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Link className="dashboard-tile__link" to="/portal/principal/message-reports">
        {t("principal.tiles.openMessageReports.link")}
      </Link>
    </DashboardTile>
  );
}
