import { Link } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import { AttendanceHeatMapTile } from "./tiles/AttendanceHeatMapTile";
import { DraftEvaluationsTile } from "./tiles/DraftEvaluationsTile";
import { OpenDisciplineIncidentsTile } from "./tiles/OpenDisciplineIncidentsTile";
import { PendingApprovalsTile } from "./tiles/PendingApprovalsTile";
import { RecentAnnouncementsTile } from "./tiles/RecentAnnouncementsTile";

import "../../components/dashboard-tile.css";
import "./principal-dashboard.css";

/** Every area of the principal's work, in the order a principal reaches for them. */
const PRINCIPAL_LINKS = [
  { key: "grades", to: "/portal/principal/grades" },
  { key: "calendar", to: "/portal/principal/calendar" },
  { key: "timetable", to: "/portal/principal/timetable" },
  { key: "classes", to: "/portal/principal/classes" },
  { key: "students", to: "/portal/principal/students" },
  { key: "attendance", to: "/portal/principal/attendance" },
  { key: "discipline", to: "/portal/principal/discipline" },
  { key: "evaluations", to: "/portal/principal/evaluations" },
  { key: "approvals", to: "/portal/approvals" },
  { key: "announcements", to: "/portal/admin/announcements" },
] as const;

/**
 * Principal home (`/portal/principal`), gated by `principalDashboard:view` (PRINCIPAL and
 * ORG_ADMIN). Links to each area of a principal's work — grades, the school calendar, timetable,
 * classes, students, attendance, discipline, evaluations, approvals, announcements — above a live
 * snapshot of what needs attention. Each tile owns its own query and loading/error/empty state
 * independently, so one failing endpoint never blocks the others from rendering (same pattern
 * `AdminDashboardPage` uses).
 */
export default function PrincipalDashboardPage() {
  const { t } = useTranslation();
  return (
    <>
      <h1>{t("principal.dashboard.title")}</h1>
      <p>{t("principal.dashboard.description")}</p>

      <ul className="link-tiles">
        {PRINCIPAL_LINKS.map((link) => (
          <li key={link.key}>
            <Link to={link.to} className="link-tiles__item">
              {t(`principal.dashboard.links.${link.key}`)}
            </Link>
          </li>
        ))}
      </ul>

      <div className="principal-dashboard-grid">
        <PendingApprovalsTile />
        <AttendanceHeatMapTile />
        <OpenDisciplineIncidentsTile />
        <DraftEvaluationsTile />
        <RecentAnnouncementsTile />
      </div>
    </>
  );
}
