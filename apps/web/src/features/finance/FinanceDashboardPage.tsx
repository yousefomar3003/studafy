import { Link } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";
import { helpPath } from "../help/content";
import { HelpLink } from "../help/HelpLink";

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
  const { t } = useTranslation();

  return (
    <>
      <h1>{t("finance.dashboard.title")}</h1>
      <p>{t("finance.dashboard.intro")}</p>
      <p>
        <HelpLink to={helpPath("workflows")}>{t("finance.dashboard.readGuide")}</HelpLink>
      </p>
      <p>
        <Link to="/portal/finance/fees">{t("finance.dashboard.nav.fees")}</Link>
        {" · "}
        <Link to="/portal/finance/invoices">{t("finance.dashboard.nav.invoices")}</Link>
        {" · "}
        <Link to="/portal/finance/payments">{t("finance.dashboard.nav.payments")}</Link>
        {" · "}
        <Link to="/portal/finance/adjustments/scholarships">
          {t("finance.dashboard.nav.scholarships")}
        </Link>
        {" · "}
        <Link to="/portal/finance/adjustments/refunds">{t("finance.dashboard.nav.refunds")}</Link>
        {" · "}
        <Link to="/portal/finance/reports">{t("finance.dashboard.nav.reports")}</Link>
        {" · "}
        <Link to="/portal/finance/expenses">{t("finance.dashboard.nav.expenses")}</Link>
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
