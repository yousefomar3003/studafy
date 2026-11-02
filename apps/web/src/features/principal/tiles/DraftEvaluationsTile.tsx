import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { useTranslation } from "../../../lib/i18n";
import { EVALUATION_TYPE_LABEL_KEYS } from "../evaluations/labels";
import { useDraftEvaluationsQuery } from "../queries";

const PREVIEW_LIMIT = 5;

/** The newest draft evaluations. Their count is the principal home's summary strip. */
export function DraftEvaluationsTile() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useDraftEvaluationsQuery();

  const evaluations = data ?? [];
  const total = evaluations.length;

  return (
    <DashboardTile
      title={t("principal.tiles.draftEvaluations.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("principal.tiles.draftEvaluations.error")}
    >
      {total === 0 ? (
        <p className="dashboard-tile__caption">{t("principal.tiles.draftEvaluations.empty")}</p>
      ) : null}

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
