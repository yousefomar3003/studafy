import { Link } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import { ActivationFunnelTile } from "./tiles/ActivationFunnelTile";
import { AttendanceTodayTile } from "./tiles/AttendanceTodayTile";
import { PendingApprovalsTile } from "./tiles/PendingApprovalsTile";
import { StorageUsageTile } from "./tiles/StorageUsageTile";
import { SubscriptionStatusBanner } from "./tiles/SubscriptionStatusBanner";

import "../../components/dashboard-tile.css";
import "./admin-dashboard.css";

/**
 * Admin home (`/portal/admin`), gated by `organization:manageSettings` (see `RequirePermission`
 * in `app/routes.tsx`) — the same permission `SetupWizardPage` uses, since both are org-admin-only
 * surfaces. Each tile owns its own query and loading/error/empty state independently, so one failing
 * endpoint never blocks the others from rendering.
 */
export default function AdminDashboardPage() {
  const { t } = useTranslation();

  return (
    <>
      <h1>{t("adminSchool.dashboard.title")}</h1>
      <p>{t("adminSchool.dashboard.intro")}</p>

      <ul className="link-tiles">
        <li>
          <Link to="/portal/admin/users" className="link-tiles__item">
            {t("adminSchool.dashboard.links.users")}
          </Link>
        </li>
        <li>
          <Link to="/portal/admin/invitations" className="link-tiles__item">
            {t("adminSchool.dashboard.links.invitations")}
          </Link>
        </li>
        <li>
          <Link to="/portal/admin/students" className="link-tiles__item">
            {t("adminSchool.dashboard.links.students")}
          </Link>
        </li>
        <li>
          <Link to="/portal/admin/timetable" className="link-tiles__item">
            {t("adminSchool.dashboard.links.timetable")}
          </Link>
        </li>
        <li>
          <Link to="/portal/admin/settings" className="link-tiles__item">
            {t("adminSchool.dashboard.links.settings")}
          </Link>
        </li>
        <li>
          <Link to="/portal/admin/audit" className="link-tiles__item">
            {t("adminSchool.dashboard.links.audit")}
          </Link>
        </li>
        <li>
          <Link to="/portal/admin/announcements" className="link-tiles__item">
            {t("adminSchool.dashboard.links.announcements")}
          </Link>
        </li>
      </ul>

      <div className="admin-dashboard-banner">
        <SubscriptionStatusBanner />
      </div>

      <div className="admin-dashboard-grid">
        <ActivationFunnelTile />
        <AttendanceTodayTile />
        <PendingApprovalsTile />
        <StorageUsageTile />
      </div>
    </>
  );
}
