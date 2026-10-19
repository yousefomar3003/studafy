import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { useTranslation } from "../../../lib/i18n";
import { DISCIPLINE_SEVERITY_LABEL_KEYS, severityTone } from "../labels";
import { useOpenIncidentsPreviewQuery } from "../queries";

/** The newest open incidents. Their count is the principal home's summary strip, not repeated here. */

export function OpenDisciplineIncidentsTile() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useOpenIncidentsPreviewQuery();

  const total = data?.total ?? 0;
  const items = data?.items ?? [];

  return (
    <DashboardTile
      title={t("principal.tiles.openIncidents.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("principal.tiles.openIncidents.error")}
    >
      {total === 0 ? (
        <p className="dashboard-tile__caption">{t("principal.tiles.openIncidents.empty")}</p>
      ) : null}

      {items.length > 0 ? (
        <ul className="principal-incident-list">
          {items.map((incident) => (
            <li key={incident.id} className="principal-incident-list__item">
              <span
                className="dashboard-tile__status-pill"
                data-tone={severityTone(incident.severity)}
              >
                {t(DISCIPLINE_SEVERITY_LABEL_KEYS[incident.severity])}
              </span>
              <span className="principal-incident-list__title">{incident.title}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Link className="dashboard-tile__link" to="/portal/principal/discipline">
        {t("principal.tiles.openIncidents.link")}
      </Link>
    </DashboardTile>
  );
}
