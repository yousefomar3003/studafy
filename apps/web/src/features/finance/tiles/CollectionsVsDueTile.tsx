import { useQuery } from "@tanstack/react-query";

import { DashboardTile } from "../../../components/DashboardTile";
import {
  COLLECTIONS_VS_DUE_QUERY_KEY,
  fetchCollectionsVsDueReport,
  reportSummaryCards,
} from "../queries";

/**
 * "Collections vs due this term" — ERPNext's own `report_summary` cards from the
 * `collections-vs-due` report (`Accounts Receivable`, payment-terms basis), verbatim. Studafy does
 * not calculate collections or due totals (see docs/modules/finance-reports-definitions.md), so
 * these numbers reconcile with the financial reports API by construction: there is no second
 * calculation to drift from the first.
 */
export function CollectionsVsDueTile() {
  const { data, isPending, isError } = useQuery({
    queryKey: COLLECTIONS_VS_DUE_QUERY_KEY,
    queryFn: fetchCollectionsVsDueReport,
  });

  const cards = data ? reportSummaryCards(data) : [];

  return (
    <DashboardTile
      title="Collections vs due this term"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load the collections report."
    >
      {cards.length === 0 ? (
        <p className="dashboard-tile__caption">No collections summary for this term yet.</p>
      ) : (
        <dl className="dashboard-tile__stat-list">
          {cards.map((card, index) => (
            <div className="dashboard-tile__stat" key={`${card.label}-${index}`}>
              <dt>{card.label || "—"}</dt>
              <dd>{card.display}</dd>
            </div>
          ))}
        </dl>
      )}
    </DashboardTile>
  );
}
