import { useApprovalQueueQuery } from "../../components/ApprovalQueueBadge";
import { HomeHeader, useSummarySentence } from "../../components/home/HomeHeader";
import { HomeShortcuts, SummaryStrip } from "../../components/home/SummaryStrip";
import { useFormatters, useTranslation } from "../../lib/i18n";

import { useAttendanceTodayQuery, useUserStatusCountsQuery } from "./queries";
import { StorageUsageTile } from "./tiles/StorageUsageTile";

import type { SummaryItem } from "../../components/home/SummaryStrip";
import type { UseQueryResult } from "@tanstack/react-query";

import "../../components/dashboard-tile.css";
import "./admin-dashboard.css";

const ADMIN_LINKS = [
  { key: "users", to: "/portal/admin/users" },
  { key: "students", to: "/portal/admin/students" },
  { key: "timetable", to: "/portal/admin/timetable" },
  { key: "calendar", to: "/portal/admin/calendar" },
  { key: "settings", to: "/portal/admin/settings" },
  { key: "announcements", to: "/portal/admin/announcements" },
] as const;

const statusOf = (query: UseQueryResult) =>
  query.isPending ? "pending" : query.isError ? "error" : "ready";

/**
 * Admin home (`/portal/admin`), gated by `organization:manageSettings` (see `RequirePermission`
 * in `app/routes.tsx`) — the same permission `SetupWizardPage` uses, since both are org-admin-only
 * surfaces. Opens with who is signed in, a one-line summary of what needs attention, and the
 * headline figures; the school's storage use follows. Every figure owns its own
 * query and loading/error state, so one failing endpoint never blocks the others from rendering.
 */
export default function AdminDashboardPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const userCounts = useUserStatusCountsQuery();
  const attendance = useAttendanceTodayQuery();
  const approvals = useApprovalQueueQuery();

  const invited = userCounts.data?.invited ?? 0;
  const active = userCounts.data?.active ?? 0;
  const pendingApprovals = approvals.data?.total ?? 0;
  const totals = attendance.data?.totals;
  const hasAttendance = Boolean(totals && totals.total_records > 0);

  const summary = useSummarySentence(
    [
      pendingApprovals > 0
        ? t("adminSchool.home.summary.approvals", { count: pendingApprovals })
        : null,
      invited > 0 ? t("adminSchool.home.summary.invited", { count: invited }) : null,
    ],
    {
      loading: userCounts.isPending || approvals.isPending,
      failed: userCounts.isError || approvals.isError,
    },
  );

  const items: SummaryItem[] = [
    {
      key: "active",
      label: t("adminSchool.home.stats.active"),
      value: formatNumber(active),
      hint: t("adminSchool.home.stats.activeHint"),
      to: "/portal/admin/users",
      status: statusOf(userCounts),
      errorMessage: t("adminSchool.tiles.activation.error"),
    },
    {
      key: "invited",
      label: t("adminSchool.tiles.activation.invited"),
      value: formatNumber(invited),
      hint: t("adminSchool.home.stats.invitedHint"),
      to: "/portal/admin/users",
      attention: invited > 0,
      status: statusOf(userCounts),
      errorMessage: t("adminSchool.tiles.activation.error"),
    },
    {
      key: "attendance",
      label: t("adminSchool.tiles.attendance.title"),
      // Nothing marked yet today reads as a dash, not "0%": nothing was measured.
      value:
        hasAttendance && totals
          ? formatNumber(Math.round(totals.present_percent) / 100, { style: "percent" })
          : "—",
      hint:
        hasAttendance && totals
          ? t("adminSchool.tiles.attendance.summary", {
              count: totals.total_records,
              present: formatNumber(totals.present_count),
              total: formatNumber(totals.total_records),
            })
          : t("adminSchool.tiles.attendance.empty"),
      status: statusOf(attendance),
      errorMessage: t("adminSchool.tiles.attendance.error"),
    },
    {
      key: "approvals",
      label: t("adminSchool.tiles.approvals.title"),
      value: formatNumber(pendingApprovals),
      hint:
        pendingApprovals === 0
          ? t("adminSchool.tiles.approvals.empty")
          : t("adminSchool.home.stats.approvalsHint"),
      to: "/portal/approvals",
      attention: pendingApprovals > 0,
      status: statusOf(approvals),
      errorMessage: t("adminSchool.tiles.approvals.error"),
    },
  ];

  return (
    <>
      <HomeHeader title={t("adminSchool.dashboard.title")} summary={summary} />
      <SummaryStrip items={items} />

      <HomeShortcuts
        links={ADMIN_LINKS.map((link) => ({
          ...link,
          label: t(`adminSchool.dashboard.links.${link.key}`),
        }))}
      />

      <section className="home-section" aria-labelledby="admin-account-heading">
        <h2 id="admin-account-heading" className="home-section-heading">
          {t("adminSchool.home.accountHeading")}
        </h2>
        <div className="admin-dashboard-grid">
          <StorageUsageTile />
        </div>
      </section>
    </>
  );
}
