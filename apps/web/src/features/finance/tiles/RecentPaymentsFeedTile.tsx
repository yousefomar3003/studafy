import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { PAYMENT_MODE_LABELS, PAYMENT_STATUS_LABELS, paymentStatusTone } from "../labels";
import { RECENT_PAYMENTS_QUERY_KEY, fetchRecentPayments } from "../queries";

import type { Payment } from "../queries";

function formatPaymentAmount(payment: Payment): string {
  return `${payment.amount} ${payment.currency}`;
}

/**
 * Recent payments feed (ST-200): the most recently recorded payments for the school, from the local
 * payment read-model (`GET /api/finance/payments`) rather than an ERPNext report — this is a plain
 * list of what was recorded, not a figure that needs to reconcile against anything. "View all" links
 * to `payments/PaymentsListPage`, the same full history this feed previews.
 */
export function RecentPaymentsFeedTile() {
  const { data, isPending, isError } = useQuery({
    queryKey: RECENT_PAYMENTS_QUERY_KEY,
    queryFn: fetchRecentPayments,
  });

  const payments = data?.payments ?? [];

  return (
    <DashboardTile
      title="Recent payments"
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage="Unable to load recent payments."
    >
      {payments.length === 0 ? (
        <p className="dashboard-tile__caption">No payments recorded yet.</p>
      ) : (
        <ul className="finance-payments-feed" role="list">
          {payments.map((payment) => (
            <li key={payment.id} className="finance-payments-feed__item">
              <div>
                <p className="finance-payments-feed__amount">{formatPaymentAmount(payment)}</p>
                <p className="dashboard-tile__caption">
                  {payment.payment_mode
                    ? PAYMENT_MODE_LABELS[payment.payment_mode]
                    : "Unknown mode"}{" "}
                  · {payment.payment_date}
                </p>
              </div>
              <span
                className="dashboard-tile__status-pill"
                data-tone={paymentStatusTone(payment.status)}
              >
                {PAYMENT_STATUS_LABELS[payment.status]}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Link className="dashboard-tile__link" to="/portal/finance/payments">
        View all payments &rarr;
      </Link>
    </DashboardTile>
  );
}
