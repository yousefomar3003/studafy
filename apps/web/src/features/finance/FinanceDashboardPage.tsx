import { Link } from "react-router-dom";

import { AgingBucketsChartTile } from "./tiles/AgingBucketsChartTile";
import { CollectionsVsDueTile } from "./tiles/CollectionsVsDueTile";
import { OverdueInstallmentsListTile } from "./tiles/OverdueInstallmentsListTile";
import { RecentPaymentsFeedTile } from "./tiles/RecentPaymentsFeedTile";

import "../../components/dashboard-tile.css";
import "./finance-dashboard.css";

/**
 * Finance home (`/portal/finance`), gated by `report:viewFinancial` — the permission the finance
 * report endpoints themselves require (see `apps/api/src/modules/finance/reports/routes.ts`), which
 * the FINANCE role and ORG_ADMIN both hold. Collections vs due, the aging chart, and the overdue
 * list all read ERPNext-backed reports Studafy passes through rather than recomputes (see
 * docs/modules/finance-reports-definitions.md); the payments feed reads the local payment cache.
 * Each tile owns its own query and loading/error/empty state independently, matching
 * `PrincipalDashboardPage` — one failing report never blocks the others from rendering.
 */
export default function FinanceDashboardPage() {
  return (
    <>
      <h1>Finance</h1>
      <p>
        Collections vs due this term, receivables aging, overdue installments, and recent payments.
      </p>
      <p>
        <Link to="/portal/finance/fees">Fee structure builder</Link>
        {" · "}
        <Link to="/portal/finance/invoices">Invoices</Link>
        {" · "}
        <Link to="/portal/finance/payments">Payments</Link>
        {" · "}
        <Link to="/portal/finance/adjustments/scholarships">Scholarships</Link>
        {" · "}
        <Link to="/portal/finance/adjustments/refunds">Refunds</Link>
        {" · "}
        <Link to="/portal/finance/reports">Reports</Link>
        {" · "}
        <Link to="/portal/finance/expenses">Expenses</Link>
      </p>

      <div className="finance-dashboard-grid">
        <CollectionsVsDueTile />
        <AgingBucketsChartTile />
        <OverdueInstallmentsListTile />
        <RecentPaymentsFeedTile />
      </div>
    </>
  );
}
