import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { EVALUATION_TYPE_LABEL_KEYS } from "../evaluations/labels";
import { evaluationListKey, fetchEvaluations } from "../evaluations/queries";

const PREVIEW_LIMIT = 5;

/** No realtime event is routed for evaluations yet (`apps/realtime/src/event-routing.ts` only routes
 * `grades.published`), so this polls like `OpenDisciplineIncidentsTile` and the admin dashboard's
 * other unrouted tiles. */
const DRAFT_EVALUATIONS_POLL_MS = 60_000;

export function DraftEvaluationsTile() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
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
      title={t("principal.tiles.draftEvaluations.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("principal.tiles.draftEvaluations.error")}
    >
      <p className="dashboard-tile__value">{formatNumber(total)}</p>
      <p className="dashboard-tile__caption">
        {total === 0
          ? t("principal.tiles.draftEvaluations.empty")
          : t("principal.tiles.draftEvaluations.caption")}
      </p>

      {evaluations.length > 0 ? (
        <ul className="principal-incident-list">
          {evaluations.slice(0, PREVIEW_LIMIT).map((evaluation) => (
            <li key={evaluation.id} className="principal-incident-list__item">
              <span className="principal-incident-list__title">
                {t(EVALUATION_TYPE_LABEL_KEYS[evaluation.evaluation_type])}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <Link className="dashboard-tile__link" to="/portal/principal/evaluations">
        {t("principal.tiles.draftEvaluations.link")}
      </Link>
    </DashboardTile>
  );
}
