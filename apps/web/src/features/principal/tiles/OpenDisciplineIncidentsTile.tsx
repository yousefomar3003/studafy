import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { DISCIPLINE_SEVERITY_LABEL_KEYS, severityTone } from "../labels";
import { fetchOpenDisciplineIncidents } from "../queries";

const PREVIEW_LIMIT = 5;

/** No realtime event is routed for discipline incidents yet (`apps/realtime/src/event-routing.ts`
 * only routes `grades.published`), so this polls like the admin dashboard's other unrouted tiles. */
const OPEN_INCIDENTS_POLL_MS = 60_000;

export function OpenDisciplineIncidentsTile() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { data, isPending, isError } = useQuery({
    queryKey: ["discipline-incidents", "open", PREVIEW_LIMIT],
    queryFn: () => fetchOpenDisciplineIncidents(PREVIEW_LIMIT),
    refetchInterval: OPEN_INCIDENTS_POLL_MS,
  });

  const total = data?.total ?? 0;
  const items = data?.items ?? [];

  return (
    <DashboardTile
      title={t("principal.tiles.openIncidents.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("principal.tiles.openIncidents.error")}
    >
      <p className="dashboard-tile__value">{formatNumber(total)}</p>
      <p className="dashboard-tile__caption">
        {total === 0
          ? t("principal.tiles.openIncidents.empty")
          : t("principal.tiles.openIncidents.caption")}
      </p>

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
