import { PERMISSIONS } from "@studafy/constants";

import type { Permission } from "@studafy/constants";

export interface PortalNavItem {
  readonly id: string;
  /** i18next key under `nav.*` (see `locales/en.json`) — `PortalSidebar` resolves it with `t()`. */
  readonly labelKey: string;
  readonly to: string;
  /** Omitted for items every authenticated session sees, regardless of role. */
  readonly requiredPermission?: Permission;
  /**
   * Runs the signed-in user's *own school* (its admin, leadership, subscription, tuition finance or
   * approvals). Hidden from Studafy platform operators (`platform:read`): SUPER_ADMIN holds every
   * permission, but operates the platform from `/portal/platform/*`, not any one school.
   */
  readonly schoolScoped?: true;
}

/**
 * The portal sidebar's full menu, in display order. This is the single source of truth for what a
 * session *could* see; `visiblePortalNavItems` narrows it to what a given permission set actually
 * shows. Only entries backed by a real route belong here — an item with no page behind it is a
 * dead link, not a preview of a future one.
 */
export const PORTAL_NAV_ITEMS: readonly PortalNavItem[] = [
  { id: "home", labelKey: "nav.home", to: "/portal" },
  // Same audience as "Home" (every authenticated session, regardless of role) — the inbox routes
  // are deliberately open to everyone (see `notificationRoutes`'s doc comment in the API), so
  // there is no `requiredPermission` to gate this on.
  { id: "notifications", labelKey: "nav.notifications", to: "/portal/notifications" },
  {
    // The Studafy platform console -- every school, plans, platform settings. Distinct from "Admin",
    // which runs the signed-in user's own school. `platform:read` is held by SUPER_ADMIN alone.
    id: "platform",
    labelKey: "nav.platform",
    to: "/portal/platform",
    requiredPermission: PERMISSIONS.PLATFORM_READ,
  },
  {
    id: "admin",
    labelKey: "nav.admin",
    to: "/portal/admin",
    requiredPermission: PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS,
    schoolScoped: true,
  },
  {
    // Principal and finance accounts, listed under "Admin" and gated the same way. Its own top-level
    // path rather than /portal/admin/staff: links match by prefix, so a nested path would light up
    // "Admin" as well.
    id: "staff",
    labelKey: "nav.staff",
    to: "/portal/accounts",
    requiredPermission: PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS,
    schoolScoped: true,
  },
  {
    // How many students, teachers and parents the school has, each with their member ID. Top-level
    // path for the same prefix-matching reason as "staff".
    id: "members",
    labelKey: "nav.members",
    to: "/portal/members",
    requiredPermission: PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS,
    schoolScoped: true,
  },
  {
    // School leadership view — approvals, attendance, discipline, evaluations, announcements —
    // rather than the ops-facing admin console (users/timetable/settings). Held by
    // PRINCIPAL and ORG_ADMIN; gated on the same permission as every /portal/principal route.
    id: "principal",
    labelKey: "nav.principal",
    to: "/portal/principal",
    requiredPermission: PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW,
    schoolScoped: true,
  },
  {
    // The attendance office -- daily registers for every class, corrections and attendance
    // reports. Held by ATTENDANCE_OFFICER and ORG_ADMIN; gated on the same permission as every
    // /portal/attendance route.
    id: "attendance",
    labelKey: "nav.attendance",
    to: "/portal/attendance",
    requiredPermission: PERMISSIONS.ATTENDANCE_DASHBOARD_VIEW,
    schoolScoped: true,
  },
  {
    id: "finance",
    labelKey: "nav.finance",
    to: "/portal/finance",
    // The same permission the finance report endpoints themselves require (see
    // apps/api/src/modules/finance/reports/routes.ts) — held by FINANCE and ORG_ADMIN.
    requiredPermission: PERMISSIONS.REPORT_VIEW_FINANCIAL,
    schoolScoped: true,
  },
  {
    id: "approvals",
    labelKey: "nav.approvals",
    to: "/portal/approvals",
    requiredPermission: PERMISSIONS.APPROVAL_REVIEW,
    schoolScoped: true,
  },
  { id: "account", labelKey: "nav.account", to: "/account" },
];

/**
 * Narrows `PORTAL_NAV_ITEMS` to the ones a session holding `permissions` is allowed to see. A
 * platform operator's menu drops the school-scoped items; its sections live inside the console.
 */
export function visiblePortalNavItems(
  permissions: ReadonlySet<Permission>,
): readonly PortalNavItem[] {
  const isPlatformOperator = permissions.has(PERMISSIONS.PLATFORM_READ);
  return PORTAL_NAV_ITEMS.filter(
    (item) =>
      (item.requiredPermission === undefined || permissions.has(item.requiredPermission)) &&
      !(isPlatformOperator && item.schoolScoped),
  );
}

/**
 * Points "Home" at the session's own home page (`resolveRoleHome`) when it has one, and drops the
 * item that already led there — so an org admin's Home *is* the admin console and stays highlighted
 * across it, rather than "Home" bouncing through `/portal` to light up "Admin" instead. Sessions
 * without a home of their own (`/portal`) get the menu unchanged.
 */
export function withRoleHome(
  items: readonly PortalNavItem[],
  roleHome: string,
): readonly PortalNavItem[] {
  if (roleHome === "/portal") return items;
  return items
    .filter((item) => item.id === "home" || item.to !== roleHome)
    .map((item) => (item.id === "home" ? { ...item, to: roleHome } : item));
}
