import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { useTranslation } from "../../../lib/i18n";
import { PAYMENT_MODE_LABEL_KEYS, PAYMENT_STATUS_LABEL_KEYS, paymentStatusTone } from "../labels";
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
  const { t } = useTranslation();
  const { data, isPending, isError } = useQuery({
    queryKey: RECENT_PAYMENTS_QUERY_KEY,
    queryFn: fetchRecentPayments,
  });

  const payments = data?.payments ?? [];

  return (
    <DashboardTile
      title={t("finance.tiles.payments.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("finance.tiles.payments.error")}
    >
      {payments.length === 0 ? (
        <p className="dashboard-tile__caption">{t("finance.tiles.payments.empty")}</p>
      ) : (
        <ul className="finance-payments-feed" role="list">
          {payments.map((payment) => (
            <li key={payment.id} className="finance-payments-feed__item">
              <div>
                <p className="finance-payments-feed__amount">{formatPaymentAmount(payment)}</p>
                <p className="dashboard-tile__caption">
                  {payment.payment_mode
                    ? t(PAYMENT_MODE_LABEL_KEYS[payment.payment_mode])
                    : t("finance.paymentMode.unknown")}{" "}
                  · {payment.payment_date}
                </p>
              </div>
              <span
                className="dashboard-tile__status-pill"
                data-tone={paymentStatusTone(payment.status)}
              >
                {t(PAYMENT_STATUS_LABEL_KEYS[payment.status])}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Link className="dashboard-tile__link" to="/portal/finance/payments">
        {t("finance.tiles.payments.viewAll")}
      </Link>
    </DashboardTile>
  );
}
