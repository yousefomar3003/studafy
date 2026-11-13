import { Link } from "react-router-dom";

import { DashboardTile } from "../../components/DashboardTile";
import { HomeIdentity, useSummarySentence } from "../../components/home/HomeHeader";
import { SummaryStrip } from "../../components/home/SummaryStrip";
import { useFormatters, useTranslation } from "../../lib/i18n";

import { PlatformPageHeader } from "./PlatformNav";
import { usePlatformOverviewQuery } from "./queries";

import type { SummaryItem } from "../../components/home/SummaryStrip";

import "../../components/dashboard-tile.css";
import "./platform.css";

const STATUS_ORDER = ["active", "registered", "pending", "suspended", "archived"] as const;

/**
 * Studafy platform console home (`/portal/platform`), gated by `platform:read` — held by
 * SUPER_ADMIN only. Where the school admin console (`/portal/admin`) runs one school, this runs
 * Studafy: every school, every subscription, every user, at once. Opens like every role's home:
 * who is signed in, a one-line summary of what needs a super admin, then the headline figures.
 */
export default function PlatformOverviewPage() {
  const { t } = useTranslation();
  const { formatNumber, formatDate } = useFormatters();
  const { data, isPending, isError } = usePlatformOverviewQuery();
  const status = isPending ? "pending" : isError ? "error" : "ready";
  const errorMessage = t("platform.overview.loadError");

  const byStatus = new Map(Object.entries(data?.schoolsByStatus ?? {}));
  const entries = (record: Record<string, number> | undefined) =>
    Object.entries(record ?? {}).sort(([, a], [, b]) => b - a);

  const pendingSchools = byStatus.get("pending") ?? 0;
  const suspendedSchools = byStatus.get("suspended") ?? 0;
  const trialsEnding = data?.trialsEndingIn7Days ?? 0;
  const summary = useSummarySentence(
    [
      pendingSchools > 0 ? t("platform.overview.summary.pending", { count: pendingSchools }) : null,
      trialsEnding > 0 ? t("platform.overview.summary.trials", { count: trialsEnding }) : null,
      suspendedSchools > 0
        ? t("platform.overview.summary.suspended", { count: suspendedSchools })
        : null,
    ],
    { loading: isPending, failed: isError },
  );

  const stat = (
    key: string,
    label: string,
    value: number | undefined,
    extra?: Partial<SummaryItem>,
  ) =>
    ({
      key,
      label,
      value: value === undefined ? "—" : formatNumber(value),
      status,
      errorMessage,
      ...extra,
    }) satisfies SummaryItem;

  const stats: SummaryItem[] = [
    stat("schools", t("platform.overview.totalSchools"), data?.totalSchools, {
      to: "/portal/platform/schools",
    }),
    stat("users", t("platform.overview.activeUsers"), data?.totalActiveUsers, {
      to: "/portal/platform/users",
    }),
    stat("students", t("platform.overview.students"), data?.totalStudents),
    stat("newSchools", t("platform.overview.newSchools"), data?.newSchoolsLast30Days),
    stat("trials", t("platform.overview.trialsEnding"), data?.trialsEndingIn7Days, {
      attention: trialsEnding > 0,
    }),
    stat("ai", t("platform.overview.aiSubscriptions"), data?.activeAiSubscriptions, {
      to: "/portal/platform/ai",
    }),
  ];

  return (
    <>
      <HomeIdentity showSchool={false} />
      <PlatformPageHeader
        title={t("platform.overview.title")}
        description={summary ?? (isError ? t("platform.overview.description") : "\u00a0")}
      />

      <SummaryStrip items={stats} />

      <div className="platform-grid">
        <DashboardTile
          title={t("platform.overview.schoolsByStatus")}
          status={status}
          errorMessage={errorMessage}
        >
          <ul className="platform-breakdown">
            {STATUS_ORDER.map((key) => (
              <li key={key}>
                <Link to={`/portal/platform/schools?status=${key}`}>
                  {t(`platform.status.${key}`)}
                </Link>
                <strong>{formatNumber(byStatus.get(key) ?? 0)}</strong>
              </li>
            ))}
          </ul>
        </DashboardTile>

        <DashboardTile
          title={t("platform.overview.subscriptionsByStatus")}
          status={status}
          errorMessage={errorMessage}
        >
          {entries(data?.subscriptionsByStatus).length === 0 ? (
            <p>{t("platform.overview.none")}</p>
          ) : (
            <ul className="platform-breakdown">
              {entries(data?.subscriptionsByStatus).map(([key, count]) => (
                <li key={key}>
                  <span>{t(`platform.subscriptionStatus.${key}`, { defaultValue: key })}</span>
                  <strong>{formatNumber(count)}</strong>
                </li>
              ))}
            </ul>
          )}
        </DashboardTile>

        <DashboardTile
          title={t("platform.overview.subscriptionsByPlan")}
          status={status}
          errorMessage={errorMessage}
        >
          {entries(data?.subscriptionsByPlan).length === 0 ? (
            <p>{t("platform.overview.none")}</p>
          ) : (
            <ul className="platform-breakdown">
              {entries(data?.subscriptionsByPlan).map(([key, count]) => (
                <li key={key}>
                  <code>{key}</code>
                  <strong>{formatNumber(count)}</strong>
                </li>
              ))}
            </ul>
          )}
        </DashboardTile>
      </div>

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
