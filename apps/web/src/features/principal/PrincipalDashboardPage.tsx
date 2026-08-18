import { AttendanceHeatMapTile } from "./tiles/AttendanceHeatMapTile";
import { DraftEvaluationsTile } from "./tiles/DraftEvaluationsTile";
import { OpenDisciplineIncidentsTile } from "./tiles/OpenDisciplineIncidentsTile";
import { PendingApprovalsTile } from "./tiles/PendingApprovalsTile";
import { RecentAnnouncementsTile } from "./tiles/RecentAnnouncementsTile";

import "../../components/dashboard-tile.css";
import "./principal-dashboard.css";

/**
 * Principal home (`/portal/principal`), gated by `organization:manageSettings` — the same
 * ORG_ADMIN-only boundary "Admin" uses (see `nav-items.ts`; there is no distinct PRINCIPAL role).
 * A leadership-facing snapshot — approvals, attendance, discipline, evaluations, announcements —
 * complementing the ops-facing admin console rather than replacing it. Each tile owns its own query
 * and loading/error/empty state independently, so one failing endpoint never blocks the others from
 * rendering (same pattern `AdminDashboardPage` uses).
 */
export default function PrincipalDashboardPage() {
  return (
    <>
      <h1>Principal</h1>
      <p>A live snapshot of approvals, attendance, discipline, evaluations, and announcements.</p>

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
