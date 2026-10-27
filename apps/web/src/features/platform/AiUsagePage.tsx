import { DataGrid } from "@studafy/ui";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { UsageRevenueSection } from "./licensing/UsageRevenueSection";
import { PlatformPageHeader } from "./PlatformNav";
import { useAiMetricsQuery } from "./queries";

import "./platform.css";

import type { PlatformAiMetrics } from "./queries";
import type { DataGridColumn } from "@studafy/ui";

type TenantRow = PlatformAiMetrics["tenants"][number];

/**
 * AI usage and margin per school (`/portal/platform/ai`), from `GET /api/ai/admin/metrics`:
 * tokens used, estimated provider cost against AI add-on revenue, and budget utilization for the
 * current billing period. Negative-margin schools sort first — they are the ones to act on.
 */
export default function AiUsagePage() {
  const { t } = useTranslation();
  const { formatCurrency, formatDate, formatNumber } = useFormatters();
  const { data, isPending, isError } = useAiMetricsQuery();

  const usd = (value: number) => formatCurrency(value, "USD");
  const percent = (value: number) => `${formatNumber(Math.round(value))}%`;
  const rows = [...(data?.tenants ?? [])].sort(
    (a, b) => Number(b.negativeMargin) - Number(a.negativeMargin) || b.totalTokens - a.totalTokens,
  );

  const columns: DataGridColumn<TenantRow>[] = [
    {
      id: "school",
      header: t("platform.ai.columns.school"),
      renderCell: (row) => (
        <Link to={`/portal/platform/schools/${row.schoolId}`}>{row.schoolName}</Link>
      ),
    },
    {
      id: "students",
      header: t("platform.ai.columns.students"),
      renderCell: (row) => formatNumber(row.subscribedStudents),
    },
    {
      id: "tokens",
      header: t("platform.ai.columns.tokens"),
      renderCell: (row) => formatNumber(row.totalTokens),
    },
    {
      id: "budget",
      header: t("platform.ai.columns.budget"),
      renderCell: (row) => percent(row.utilizationPercent),
    },
    {
      id: "cost",
      header: t("platform.ai.columns.cost"),
      renderCell: (row) => usd(row.estimatedCostUsd),
    },
    {
      id: "revenue",
      header: t("platform.ai.columns.revenue"),
      renderCell: (row) => usd(row.revenueUsd),
    },
    {
      id: "margin",
      header: t("platform.ai.columns.margin"),
      renderCell: (row) =>
        row.marginPercent === null ? (
          "—"
        ) : (
          <span className="platform-pill" data-tone={row.negativeMargin ? "danger" : "success"}>
            {percent(row.marginPercent)}
          </span>
        ),
    },
  ];

  const summary = data?.summary;

  return (
    <>
      <PlatformPageHeader
        title={t("platform.ai.title")}
        description={
          data
            ? t("platform.ai.period", {
                start: formatDate(new Date(data.periodStart), { dateStyle: "medium" }),
                end: formatDate(new Date(data.periodEnd), { dateStyle: "medium" }),
              })
            : t("platform.ai.description")
        }
      />

      <div className="platform-stats">
        <Stat
          label={t("platform.ai.schools")}
          value={summary && formatNumber(summary.totalTenants)}
        />
        <Stat
          label={t("platform.ai.students")}
          value={summary && formatNumber(summary.totalSubscribedStudents)}
        />
        <Stat
          label={t("platform.ai.tokens")}
          value={summary && formatNumber(summary.totalTokens)}
        />
        <Stat label={t("platform.ai.cost")} value={summary && usd(summary.totalEstimatedCostUsd)} />
        <Stat label={t("platform.ai.revenue")} value={summary && usd(summary.totalRevenueUsd)} />
        <Stat
          label={t("platform.ai.negativeMargin")}
          value={summary && formatNumber(summary.negativeMarginTenantCount)}
        />
      </div>

      <DataGrid
        caption={t("platform.ai.caption")}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.schoolId}
        getRowLabel={(row) => row.schoolName}
        loading={isPending}
        empty={isError ? t("platform.ai.loadError") : t("platform.ai.empty")}
      />

      <UsageRevenueSection
        aiCostUsdBySchool={new Map(rows.map((row) => [row.schoolId, row.estimatedCostUsd]))}
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="platform-stat">
      <span className="platform-stat__label">{label}</span>
      <span className="platform-stat__value">{value ?? "—"}</span>
    </div>
  );
}
