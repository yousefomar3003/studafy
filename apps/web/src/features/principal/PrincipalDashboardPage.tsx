import { PERMISSIONS } from "@studafy/constants";

import { useApprovalQueueQuery } from "../../components/ApprovalQueueBadge";
import { HomeHeader, useSummarySentence } from "../../components/home/HomeHeader";
import { HomeShortcuts, SummaryStrip } from "../../components/home/SummaryStrip";
import { usePermissions } from "../../lib/auth";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { LicenseTile } from "../license/LicenseTile";
import { MissingRecordsTile } from "../records/missing/MissingRecordsTile";

import {
  useDraftEvaluationsQuery,
  useOpenIncidentsPreviewQuery,
  useOpenMessageReportsPreviewQuery,
} from "./queries";
import { AttendanceHeatMapTile } from "./tiles/AttendanceHeatMapTile";
import { DraftEvaluationsTile } from "./tiles/DraftEvaluationsTile";
import { OpenDisciplineIncidentsTile } from "./tiles/OpenDisciplineIncidentsTile";
import { OpenMessageReportsTile } from "./tiles/OpenMessageReportsTile";
import { RecentAnnouncementsTile } from "./tiles/RecentAnnouncementsTile";

import type { SummaryItem } from "../../components/home/SummaryStrip";
import type { Permission } from "@studafy/constants";
import type { UseQueryResult } from "@tanstack/react-query";

import "../../components/dashboard-tile.css";
import "./principal-dashboard.css";

/** Every area of the principal's work, in the order a principal reaches for them. A link with a
 * `permission` is shown only to sessions holding it (its route is gated on the same one). */
const PRINCIPAL_LINKS: readonly {
  key: string;
  to: string;
  permission?: Permission;
  /** A translation key outside `principal.dashboard.links`, for links owned by another area. */
  labelKey?: string;
}[] = [
  { key: "grades", to: "/portal/principal/grades" },
  { key: "calendar", to: "/portal/principal/calendar" },
  { key: "timetable", to: "/portal/principal/timetable" },
  { key: "classes", to: "/portal/principal/classes" },
  {
    key: "sections",
    to: "/portal/principal/sections",
    permission: PERMISSIONS.TIMETABLE_MANAGE,
  },
  {
    key: "academicSetup",
    to: "/portal/principal/academic-setup",
    permission: PERMISSIONS.ACADEMIC_CONFIG_READ,
  },
  { key: "students", to: "/portal/principal/students" },
  { key: "attendance", to: "/portal/principal/attendance" },
  { key: "discipline", to: "/portal/principal/discipline" },
  { key: "messageReports", to: "/portal/principal/message-reports" },
  { key: "evaluations", to: "/portal/principal/evaluations" },
  { key: "approvals", to: "/portal/approvals" },
  { key: "announcements", to: "/portal/admin/announcements" },
  // School-defined student and parent records (features/records).
  {
    key: "recordTemplates",
    to: "/portal/principal/school/records",
    permission: PERMISSIONS.RECORD_TEMPLATE_MANAGE,
    labelKey: "recordTemplates.links.templates",
  },
  {
    key: "missingRecords",
    to: "/portal/principal/records/missing",
    permission: PERMISSIONS.STUDENT_RECORD_READ,
    labelKey: "recordTemplates.links.missing",
  },
];

const statusOf = (query: UseQueryResult) =>
  query.isPending ? "pending" : query.isError ? "error" : "ready";

/**
 * Principal home (`/portal/principal`), gated by `principalDashboard:view` (PRINCIPAL and
 * ORG_ADMIN). Opens with who is signed in, a one-line summary of what is waiting, and the four
 * counts a principal acts on; the tiles below list the items behind those counts, plus attendance
 * by class and recent announcements. Every figure and tile owns its own query and loading/error
 * state, so one failing endpoint never blocks the others from rendering.
 */
export default function PrincipalDashboardPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const permissions = usePermissions();
  const approvals = useApprovalQueueQuery();
  const incidents = useOpenIncidentsPreviewQuery();
  const reports = useOpenMessageReportsPreviewQuery();
  const evaluations = useDraftEvaluationsQuery();

  const counts = {
    approvals: approvals.data?.total ?? 0,
    incidents: incidents.data?.total ?? 0,
    reports: reports.data?.total ?? 0,
    evaluations: evaluations.data?.length ?? 0,
  };

  const summary = useSummarySentence(
    [
      counts.approvals > 0
        ? t("principal.home.summary.approvals", { count: counts.approvals })
        : null,
      counts.incidents > 0
        ? t("principal.home.summary.incidents", { count: counts.incidents })
        : null,
      counts.reports > 0 ? t("principal.home.summary.reports", { count: counts.reports }) : null,
    ],
    {
      loading: approvals.isPending || incidents.isPending || reports.isPending,
      failed: approvals.isError || incidents.isError || reports.isError,
    },
  );

  const items: SummaryItem[] = [
    {
      key: "approvals",
      label: t("principal.tiles.pendingApprovals.title"),
      value: formatNumber(counts.approvals),
      hint:
        counts.approvals === 0
          ? t("principal.tiles.pendingApprovals.empty")
          : t("principal.home.stats.approvalsHint"),
      to: "/portal/approvals",
      attention: counts.approvals > 0,
      status: statusOf(approvals),
      errorMessage: t("principal.tiles.pendingApprovals.error"),
    },
    {
      key: "incidents",
      label: t("principal.home.stats.incidents"),
      value: formatNumber(counts.incidents),
      hint: t("principal.home.stats.incidentsHint"),
      to: "/portal/principal/discipline",
      attention: counts.incidents > 0,
      status: statusOf(incidents),
      errorMessage: t("principal.tiles.openIncidents.error"),
    },
    {
      key: "reports",
      label: t("principal.home.stats.reports"),
      value: formatNumber(counts.reports),
      hint: t("principal.home.stats.reportsHint"),
      to: "/portal/principal/message-reports",
      attention: counts.reports > 0,
      status: statusOf(reports),
      errorMessage: t("principal.tiles.openMessageReports.error"),
    },
    {
      key: "evaluations",
      label: t("principal.tiles.draftEvaluations.title"),
      value: formatNumber(counts.evaluations),
      hint: t("principal.home.stats.evaluationsHint"),
      to: "/portal/principal/evaluations",
      status: statusOf(evaluations),
      errorMessage: t("principal.tiles.draftEvaluations.error"),
    },
  ];

  return (
    <>
      <HomeHeader title={t("principal.dashboard.title")} summary={summary} />
      <SummaryStrip items={items} />

      <HomeShortcuts
        links={PRINCIPAL_LINKS.filter(
          (link) => link.permission === undefined || permissions.has(link.permission),
        ).map((link) => ({
          key: link.key,
          to: link.to,
          label: t(link.labelKey ?? `principal.dashboard.links.${link.key}`),
        }))}
      />

      <section className="home-section" aria-labelledby="principal-attention-heading">
        <h2 id="principal-attention-heading" className="home-section-heading">
          {t("principal.home.attentionHeading")}
        </h2>
        <div className="principal-dashboard-grid">
          <OpenDisciplineIncidentsTile />
          <OpenMessageReportsTile />
          <DraftEvaluationsTile />
          {permissions.has(PERMISSIONS.STUDENT_RECORD_READ) ? <MissingRecordsTile /> : null}
        </div>
      </section>

      <section className="home-section" aria-labelledby="principal-activity-heading">
        <h2 id="principal-activity-heading" className="home-section-heading">
          {t("principal.home.activityHeading")}
        </h2>
        <div className="principal-dashboard-grid">
          <AttendanceHeatMapTile />
          <RecentAnnouncementsTile />
          {permissions.has(PERMISSIONS.LICENSE_READ) ? <LicenseTile /> : null}
        </div>
      </section>
    </>
  );
}
