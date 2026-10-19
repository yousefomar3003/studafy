import { ROLES } from "@studafy/constants";

import { HomeHeader, useSummarySentence } from "../../components/home/HomeHeader";
import { HomeShortcuts, SummaryStrip } from "../../components/home/SummaryStrip";
import { useAuth } from "../../lib/auth";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { helpPath } from "../help/content";
import { HelpLink } from "../help/HelpLink";

import {
  overdueInstallments,
  reportSummaryCards,
  todayIsoDate,
  useCollectionsVsDueQuery,
} from "./queries";
import { AgingBucketsChartTile } from "./tiles/AgingBucketsChartTile";
import { OverdueInstallmentsListTile } from "./tiles/OverdueInstallmentsListTile";
import { RecentPaymentsFeedTile } from "./tiles/RecentPaymentsFeedTile";

import type { SummaryItem } from "../../components/home/SummaryStrip";

import "../../components/dashboard-tile.css";
import "./finance-dashboard.css";

/**
 * Finance home (`/portal/finance`), gated by `report:viewFinancial` — the permission the finance
 * report endpoints themselves require (see `apps/api/src/modules/finance/reports/routes.ts`), which
 * the FINANCE role and ORG_ADMIN both hold. The summary strip shows ERPNext's own `report_summary`
 * cards from the collections-vs-due report verbatim, beside the overdue count drawn from that same
 * report; the aging chart and overdue list read ERPNext-backed reports Studafy passes through rather
 * than recomputes (see docs/modules/finance-reports-definitions.md); the payments feed reads the
 * local payment cache. Each figure and tile owns its own loading/error state.
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
  { key: "refunds", to: "/portal/finance/adjustments/refunds", managementOnly: false },
  { key: "reports", to: "/portal/finance/reports", managementOnly: false },
  { key: "expenses", to: "/portal/finance/expenses", managementOnly: true },
] as const;

export default function FinanceDashboardPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { roles } = useAuth();
  const canManage = roles.includes(ROLES.FINANCE);
  const links = canManage ? FINANCE_LINKS : FINANCE_LINKS.filter((link) => !link.managementOnly);

  const collections = useCollectionsVsDueQuery();
  const status = collections.isPending ? "pending" : collections.isError ? "error" : "ready";
  const cards = collections.data ? reportSummaryCards(collections.data) : [];
  // `null` when the report lacks the columns needed to tell what is overdue.
  const overdue = collections.data ? overdueInstallments(collections.data, todayIsoDate()) : [];
  const overdueCount = overdue?.length ?? 0;

  const summary = useSummarySentence(
    [overdueCount > 0 ? t("finance.home.summary.overdue", { count: overdueCount }) : null],
    { loading: collections.isPending, failed: collections.isError || overdue === null },
  );

  const collectionItems: SummaryItem[] =
    status === "ready" && cards.length > 0
      ? cards.map((card, index) => ({
          key: `collections-${index}`,
          label: card.label || "—",
          value: card.display,
          hint: t("finance.home.stats.thisTerm"),
          to: "/portal/finance/reports",
          status,
        }))
      : [
          {
            key: "collections",
            label: t("finance.home.stats.collections"),
            value: "—",
            hint: t("finance.tiles.collections.empty"),
            to: "/portal/finance/reports",
            status,
            errorMessage: t("finance.tiles.collections.error"),
          },
        ];

  const items: SummaryItem[] = [
    ...collectionItems,
    {
      key: "overdue",
      label: t("finance.tiles.overdue.title"),
      value: overdue === null ? "—" : formatNumber(overdueCount),
      hint:
        overdue === null
          ? t("finance.tiles.overdue.missingColumns")
          : t("finance.home.stats.overdueHint"),
      to: "/portal/finance/overdue",
      attention: overdueCount > 0,
      status,
      errorMessage: t("finance.tiles.overdue.error"),
    },
  ];

  return (
    <>
      <HomeHeader title={t("finance.dashboard.title")} summary={summary}>
        <p className="finance-home__guide">
          <HelpLink to={helpPath("workflows")}>{t("finance.dashboard.readGuide")}</HelpLink>
        </p>
      </HomeHeader>
      <SummaryStrip items={items} />

      <HomeShortcuts
        links={links.map((link) => ({
          key: link.key,
          to: link.to,
          label: t(`finance.dashboard.nav.${link.key}`),
        }))}
      />

      <div className="finance-dashboard-grid">
        <OverdueInstallmentsListTile />
        <AgingBucketsChartTile />
        <RecentPaymentsFeedTile />
      </div>
    </>
  );
}
