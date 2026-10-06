import { ROLES } from "@studafy/constants";
import { Link } from "react-router-dom";

import { useAuth } from "../../lib/auth";
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
 *
 * Day-to-day finance work belongs to the FINANCE role, so only it gets the full set of management
 * links. Everyone else who reaches this page (school and super admins) gets a read-only overview:
 * the tiles, the reports, and refunds, the last kept because approving a refund is the admin's
 * second sign-off (`billing:refund`, which FINANCE does not hold). This is a UX split, not an
 * authorization boundary — both roles hold the same `billing:*` permissions and the API is unchanged.
 */
const FINANCE_LINKS = [
  { key: "fees", to: "/portal/finance/fees", managementOnly: true },
  { key: "invoices", to: "/portal/finance/invoices", managementOnly: true },
  { key: "payments", to: "/portal/finance/payments", managementOnly: true },
  { key: "scholarships", to: "/portal/finance/adjustments/scholarships", managementOnly: true },
  { key: "refunds", to: "/portal/finance/adjustments/refunds", managementOnly: false },
  { key: "reports", to: "/portal/finance/reports", managementOnly: false },
  { key: "expenses", to: "/portal/finance/expenses", managementOnly: true },
] as const;

export default function FinanceDashboardPage() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const canManage = roles.includes(ROLES.FINANCE);
  const links = canManage ? FINANCE_LINKS : FINANCE_LINKS.filter((link) => !link.managementOnly);

  return (
    <>
      <h1>{t("finance.dashboard.title")}</h1>
      <p>{t("finance.dashboard.intro")}</p>
      <p>
        <HelpLink to={helpPath("workflows")}>{t("finance.dashboard.readGuide")}</HelpLink>
      </p>
      <ul className="link-tiles">
        {links.map((link) => (
          <li key={link.key}>
            <Link to={link.to} className="link-tiles__item">
              {t(`finance.dashboard.nav.${link.key}`)}
            </Link>
          </li>
        ))}
      </ul>

      <div className="finance-dashboard-grid">
        <CollectionsVsDueTile />
        <AgingBucketsChartTile />
        <OverdueInstallmentsListTile />
        <RecentPaymentsFeedTile />
      </div>
    </>
  );
}
