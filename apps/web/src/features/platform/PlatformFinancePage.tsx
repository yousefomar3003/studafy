import { DataGrid } from "@studafy/ui";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../components/DashboardTile";
import { useFormatters, useTranslation } from "../../lib/i18n";

import { PlatformPageHeader } from "./PlatformNav";
import { usePlatformFinanceQuery } from "./queries";

import "../../components/dashboard-tile.css";
import "./platform.css";

import type { PlatformFinance } from "./queries";
import type { DataGridColumn } from "@studafy/ui";

type AttentionRow = PlatformFinance["attention"][number];
type FailedRenewalRow = PlatformFinance["recentFailedRenewals"][number];

/** Overdue money is red; anything still recoverable without chasing is amber. */
const REASON_TONE: Record<AttentionRow["reason"], "danger" | "warning"> = {
  past_due: "danger",
  grace_period: "danger",
  paused: "warning",
  cancel_scheduled: "warning",
  trial_ending: "warning",
};

/**
 * Studafy's own finance (`/portal/platform/finance`): what the platform earns from schools, not a
 * school's tuition billing (that is `/portal/finance`, which a platform operator has no school
 * for). Gated by `platform:read`, held by SUPER_ADMIN only.
 */
export default function PlatformFinancePage() {
  const { t } = useTranslation();
  const { formatCurrency, formatDate, formatNumber } = useFormatters();
  const { data, isPending, isError } = usePlatformFinanceQuery();
  const status = isPending ? "pending" : isError ? "error" : "ready";
  const errorMessage = t("platform.finance.loadError");

  const money = (amountMinor: number, currencyCode: string, minorUnit: number) =>
    formatCurrency(amountMinor / 10 ** minorUnit, currencyCode);
  const date = (value: string | null) =>
    value ? formatDate(new Date(value), { dateStyle: "medium" }) : "—";

  const attentionColumns: DataGridColumn<AttentionRow>[] = [
    {
      id: "school",
      header: t("platform.finance.columns.school"),
      renderCell: (row) => (
        <Link to={`/portal/platform/schools/${row.schoolId}`}>{row.schoolName}</Link>
      ),
    },
    {
      id: "reason",
      header: t("platform.finance.columns.reason"),
      renderCell: (row) => (
        <span className="platform-pill" data-tone={REASON_TONE[row.reason]}>
          {t(`platform.finance.reasons.${row.reason}`)}
        </span>
      ),
    },
    {
      id: "plan",
      header: t("platform.finance.columns.plan"),
      renderCell: (row) => (
        <div className="platform-cell-stack">
          <span>{row.planName}</span>
          <span className="platform-muted">
            {t(`platform.subscriptionStatus.${row.subscriptionStatus}`, {
              defaultValue: row.subscriptionStatus,
            })}
          </span>
        </div>
      ),
    },
    {
      id: "due",
      header: t("platform.finance.columns.dueAt"),
      renderCell: (row) => date(row.dueAt),
    },
  ];

  const failedColumns: DataGridColumn<FailedRenewalRow>[] = [
    {
      id: "school",
      header: t("platform.finance.columns.school"),
      renderCell: (row) => (
        <Link to={`/portal/platform/schools/${row.schoolId}`}>{row.schoolName}</Link>
      ),
    },
    {
      id: "type",
      header: t("platform.finance.columns.type"),
      renderCell: (row) => t(`platform.finance.subscriptionType.${row.subscriptionType}`),
    },
    {
      id: "amount",
      header: t("platform.finance.columns.amount"),
      renderCell: (row) => money(row.amountMinor, row.currencyCode, row.minorUnit),
    },
    {
      id: "attempted",
      header: t("platform.finance.columns.attemptedAt"),
      renderCell: (row) => date(row.attemptedAt),
    },
    {
      id: "failure",
      header: t("platform.finance.columns.failureReason"),
      renderCell: (row) => row.failureReason ?? "—",
    },
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platform.finance.title")}
        description={t("platform.finance.description")}
      />

      <div className="platform-grid">
        <DashboardTile
          title={t("platform.finance.mrr")}
          status={status}
          errorMessage={errorMessage}
        >
          {data?.revenueByCurrency.length ? (
            <ul className="platform-breakdown">
              {data.revenueByCurrency.map((row) => (
                <li key={row.currencyCode}>
                  <span>{t("platform.finance.billedSchools", { count: row.billedSchools })}</span>
                  <strong>{money(row.estimatedMrrMinor, row.currencyCode, row.minorUnit)}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("platform.overview.none")}</p>
          )}
          <p className="platform-muted">{t("platform.finance.mrrNote")}</p>
        </DashboardTile>

        <DashboardTile
          title={t("platform.finance.renewals")}
          status={status}
          errorMessage={errorMessage}
        >
          {data?.renewalsLast30Days.length ? (
            <table className="platform-table">
              <thead>
                <tr>
                  <th scope="col">{t("platform.finance.columns.collected")}</th>
                  <th scope="col">{t("platform.finance.columns.succeeded")}</th>
                  <th scope="col">{t("platform.finance.columns.failed")}</th>
                </tr>
              </thead>
              <tbody>
                {data.renewalsLast30Days.map((row) => (
                  <tr key={row.currencyCode}>
                    <td>{money(row.collectedMinor, row.currencyCode, row.minorUnit)}</td>
                    <td>{formatNumber(row.succeeded)}</td>
                    <td>{formatNumber(row.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>{t("platform.overview.none")}</p>
          )}
        </DashboardTile>
      </div>

      <section className="platform-stack" aria-labelledby="platform-finance-attention">
        <h2 id="platform-finance-attention">{t("platform.finance.attention")}</h2>
        <p className="platform-muted">{t("platform.finance.attentionHelp")}</p>
        <DataGrid
          caption={t("platform.finance.attention")}
          columns={attentionColumns}
          rows={data?.attention ?? []}
          getRowId={(row) => `${row.schoolId}:${row.reason}`}
          getRowLabel={(row) => row.schoolName}
          loading={isPending}
          empty={isError ? errorMessage : t("platform.finance.attentionEmpty")}
        />
      </section>

      <section className="platform-stack" aria-labelledby="platform-finance-failed">
        <h2 id="platform-finance-failed">{t("platform.finance.failedRenewals")}</h2>
        <DataGrid
          caption={t("platform.finance.failedRenewals")}
          columns={failedColumns}
          rows={data?.recentFailedRenewals ?? []}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.schoolName}
          loading={isPending}
          empty={isError ? errorMessage : t("platform.finance.failedEmpty")}
        />
      </section>

      {data ? (
        <p className="platform-muted">
          {t("platform.overview.generatedAt", {
            time: formatDate(new Date(data.generatedAt), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </p>
      ) : null}
    </>
  );
}
