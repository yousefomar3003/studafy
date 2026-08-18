import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { EVALUATION_TYPE_LABELS } from "../evaluations/labels";
import { evaluationListKey, fetchEvaluations } from "../evaluations/queries";

const PREVIEW_LIMIT = 5;

/** No realtime event is routed for evaluations yet (`apps/realtime/src/event-routing.ts` only routes
 * `grades.published`), so this polls like `OpenDisciplineIncidentsTile` and the admin dashboard's
 * other unrouted tiles. */
const DRAFT_EVALUATIONS_POLL_MS = 60_000;

export function DraftEvaluationsTile() {
  const filter = { status: "draft" as const };
  const { data, isPending, isError } = useQuery({
    queryKey: evaluationListKey(filter),
    queryFn: () => fetchEvaluations(filter),
    refetchInterval: DRAFT_EVALUATIONS_POLL_MS,
  });

  const evaluations = data ?? [];
  const total = evaluations.length;

  return (
    <DashboardTile
      title="Draft evaluations"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load evaluations."
    >
      <p className="dashboard-tile__value">{total}</p>
      <p className="dashboard-tile__caption">
        {total === 0 ? "No evaluations in progress." : "awaiting scoring, submission, or sharing"}
      </p>

      {evaluations.length > 0 ? (
        <ul className="principal-incident-list">
          {evaluations.slice(0, PREVIEW_LIMIT).map((evaluation) => (
            <li key={evaluation.id} className="principal-incident-list__item">
              <span className="principal-incident-list__title">
                {EVALUATION_TYPE_LABELS[evaluation.evaluation_type]}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <Link className="dashboard-tile__link" to="/portal/principal/evaluations">
        View evaluations →
      </Link>
    </DashboardTile>
  );
}
