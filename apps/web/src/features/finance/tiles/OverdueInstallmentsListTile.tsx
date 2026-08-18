import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
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
  const { data, isPending, isError } = useQuery({
    queryKey: COLLECTIONS_VS_DUE_QUERY_KEY,
    queryFn: fetchCollectionsVsDueReport,
  });

  const installments = data ? overdueInstallments(data, todayIsoDate()) : [];
  const preview = (installments ?? []).slice(0, PREVIEW_LIMIT);

  return (
    <DashboardTile
      title="Overdue installments"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load overdue installments."
    >
      {installments === null ? (
        <p className="dashboard-tile__caption">
          The collections report didn&rsquo;t include the columns this needs.
        </p>
      ) : preview.length === 0 ? (
        <p className="dashboard-tile__caption">Nothing is overdue.</p>
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
                  Due {installment.dueDate} · {installment.daysOverdue}d overdue
                </p>
              </div>
              <span className="finance-overdue-list__amount">{installment.outstandingDisplay}</span>
            </li>
          ))}
        </ul>
      )}

      <Link className="dashboard-tile__link" to="/portal/finance/overdue">
        View all overdue installments →
      </Link>
    </DashboardTile>
  );
}
