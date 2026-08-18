import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { AR_AGING_QUERY_KEY, agingBuckets, fetchArAgingReport, formatAmount } from "../queries";

type BucketTone = "accent" | "warning" | "danger";

/** The first bucket (`range1`, 0-30 days) is barely late; the last is the worst regardless of how
 * many buckets ERPNext returns. Middle buckets share "warning" — there are only three severity
 * tones in the design system (accent/warning/danger), and a 4-5 bucket report has more buckets than
 * that. */
function toneForBucket(index: number, count: number): BucketTone {
  if (index === count - 1) return "danger";
  if (index === 0) return "accent";
  return "warning";
}

/**
 * Aging buckets chart (ST-200): ERPNext's own `range1..rangeN` columns from the `ar-aging` report
 * ("Accounts Receivable Summary"), summed across every party row and drawn as bars — no chart
 * library, matching the plain CSS treatment `AttendanceHeatMapTile` already uses for its heat map.
 * Each bar drills through to `/portal/finance/overdue?bucket=<fieldname>`, filtering the overdue
 * installments list to the same day range.
 */
export function AgingBucketsChartTile() {
  const { data, isPending, isError } = useQuery({
    queryKey: AR_AGING_QUERY_KEY,
    queryFn: fetchArAgingReport,
  });

  const report = data;
  const buckets = report ? agingBuckets(report) : [];
  const maxTotal = Math.max(1, ...buckets.map((bucket) => bucket.total));

  return (
    <DashboardTile
      title="Aging buckets"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load the accounts receivable aging report."
    >
      {!report || buckets.length === 0 ? (
        <p className="dashboard-tile__caption">No outstanding receivables to age.</p>
      ) : (
        <ul className="finance-aging-chart" role="list">
          {buckets.map((bucket, index) => (
            <li key={bucket.fieldname}>
              <Link
                className="finance-aging-chart__row"
                to={`/portal/finance/overdue?bucket=${bucket.fieldname}`}
              >
                <span className="finance-aging-chart__label">{bucket.label}</span>
                <span className="finance-aging-chart__track">
                  <span
                    className="finance-aging-chart__fill"
                    data-tone={toneForBucket(index, buckets.length)}
                    style={{ width: `${Math.max(2, (bucket.total / maxTotal) * 100)}%` }}
                  />
                </span>
                <span className="finance-aging-chart__value">
                  {formatAmount(bucket.total, report)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link className="dashboard-tile__link" to="/portal/finance/overdue">
        View overdue installments →
      </Link>
    </DashboardTile>
  );
}
