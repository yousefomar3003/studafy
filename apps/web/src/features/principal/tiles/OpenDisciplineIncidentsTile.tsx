import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { DISCIPLINE_SEVERITY_LABELS, severityTone } from "../labels";
import { fetchOpenDisciplineIncidents } from "../queries";

const PREVIEW_LIMIT = 5;

/** No realtime event is routed for discipline incidents yet (`apps/realtime/src/event-routing.ts`
 * only routes `grades.published`), so this polls like the admin dashboard's other unrouted tiles. */
const OPEN_INCIDENTS_POLL_MS = 60_000;

export function OpenDisciplineIncidentsTile() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["discipline-incidents", "open", PREVIEW_LIMIT],
    queryFn: () => fetchOpenDisciplineIncidents(PREVIEW_LIMIT),
    refetchInterval: OPEN_INCIDENTS_POLL_MS,
  });

  const total = data?.total ?? 0;
  const items = data?.items ?? [];

  return (
    <DashboardTile
      title="Open discipline incidents"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load discipline incidents."
    >
      <p className="dashboard-tile__value">{total}</p>
      <p className="dashboard-tile__caption">
        {total === 0 ? "No open incidents." : "reported, under review, or escalated"}
      </p>

      {items.length > 0 ? (
        <ul className="principal-incident-list">
          {items.map((incident) => (
            <li key={incident.id} className="principal-incident-list__item">
              <span
                className="dashboard-tile__status-pill"
                data-tone={severityTone(incident.severity)}
              >
                {DISCIPLINE_SEVERITY_LABELS[incident.severity]}
              </span>
              <span className="principal-incident-list__title">{incident.title}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Link className="dashboard-tile__link" to="/portal/principal/discipline">
        View discipline incidents →
      </Link>
    </DashboardTile>
  );
}
