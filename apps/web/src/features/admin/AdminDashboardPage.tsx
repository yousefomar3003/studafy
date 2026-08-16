import { Link } from "react-router-dom";

import { ActivationFunnelTile } from "./tiles/ActivationFunnelTile";
import { AttendanceTodayTile } from "./tiles/AttendanceTodayTile";
import { PendingApprovalsTile } from "./tiles/PendingApprovalsTile";
import { StorageUsageTile } from "./tiles/StorageUsageTile";
import { SubscriptionStatusBanner } from "./tiles/SubscriptionStatusBanner";

import "./admin-dashboard.css";

/**
 * Admin home (`/portal/admin`), gated by `organization:manageSettings` (see `RequirePermission`
 * in `app/routes.tsx`) — the same permission `SetupWizardPage` uses, since both are org-admin-only
 * surfaces. Each tile owns its own query and loading/error/empty state independently, so one failing
 * endpoint never blocks the others from rendering.
 */
export default function AdminDashboardPage() {
  return (
    <>
      <h1>Admin</h1>
      <p>A live snapshot of activation, attendance, approvals, and account health.</p>

      <p className="admin-dashboard-link">
        <Link to="/portal/admin/users">Manage users →</Link>
      </p>
      <p className="admin-dashboard-link">
        <Link to="/portal/admin/invitations">Manage invitations →</Link>
      </p>
      <p className="admin-dashboard-link">
        <Link to="/portal/admin/students">Manage students →</Link>
      </p>

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
