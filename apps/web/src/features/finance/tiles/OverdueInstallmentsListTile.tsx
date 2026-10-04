import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { useTranslation } from "../../../lib/i18n";
import {
  COLLECTIONS_VS_DUE_QUERY_KEY,
  fetchCollectionsVsDueReport,
  overdueInstallments,
  todayIsoDate,
} from "../queries";

const PREVIEW_LIMIT = 5;

/**
 * Overdue installments (ST-200): the same `collections-vs-due` report the KPI tile reads, filtered
 * to rows past due with a balance owed (see `overdueInstallments` in `queries.ts`). Sharing the
 * query key with `CollectionsVsDueTile` means TanStack Query dedupes the request between the two
 * tiles rather than fetching the same report twice.
 */
export function OverdueInstallmentsListTile() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useQuery({
    queryKey: COLLECTIONS_VS_DUE_QUERY_KEY,
    queryFn: fetchCollectionsVsDueReport,
  });

  const installments = data ? overdueInstallments(data, todayIsoDate()) : [];
  const preview = (installments ?? []).slice(0, PREVIEW_LIMIT);

  return (
    <DashboardTile
      title={t("finance.tiles.overdue.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("finance.tiles.overdue.error")}
    >
      {installments === null ? (
        <p className="dashboard-tile__caption">{t("finance.tiles.overdue.missingColumns")}</p>
      ) : preview.length === 0 ? (
        <p className="dashboard-tile__caption">{t("finance.tiles.overdue.empty")}</p>
      ) : (
        <ul className="finance-overdue-list" role="list">
          {preview.map((installment, index) => (
            <li
              key={`${installment.reference || installment.partyName}-${index}`}
              className="finance-overdue-list__item"
            >
              <div>
                <p className="finance-overdue-list__party">{installment.partyName || "—"}</p>
                <p className="dashboard-tile__caption">
                  {t("finance.tiles.overdue.dueLine", {
                    date: installment.dueDate,
                    count: installment.daysOverdue,
                  })}
                </p>
              </div>
              <span className="finance-overdue-list__amount">{installment.outstandingDisplay}</span>
            </li>
          ))}
        </ul>
      )}

      <Link className="dashboard-tile__link" to="/portal/finance/overdue">
        {t("finance.tiles.overdue.viewAll")}
      </Link>
    </DashboardTile>
  );
}
