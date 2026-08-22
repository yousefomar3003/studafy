import { PERMISSIONS } from "@studafy/constants";

import type { Permission } from "@studafy/constants";

export interface PortalNavItem {
  readonly id: string;
  readonly label: string;
  readonly to: string;
  /** Omitted for items every authenticated session sees, regardless of role. */
  readonly requiredPermission?: Permission;
}

/**
 * The portal sidebar's full menu, in display order. This is the single source of truth for what a
 * session *could* see; `visiblePortalNavItems` narrows it to what a given permission set actually
 * shows. Only entries backed by a real route belong here — an item with no page behind it is a
 * dead link, not a preview of a future one.
 */
export const PORTAL_NAV_ITEMS: readonly PortalNavItem[] = [
  { id: "home", label: "Home", to: "/portal" },
  {
    id: "admin",
    label: "Admin",
    to: "/portal/admin",
    requiredPermission: PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS,
  },
  {
    // Same audience as "Admin" (there is no distinct PRINCIPAL role — see
    // ATTENDANCE_CORRECTION_OVERRIDE's doc comment in packages/constants/src/permissions.ts, which
    // already calls ORG_ADMIN "a principal's administrative override"). A separate leadership-facing
    // view — approvals, attendance, discipline, announcements — rather than the ops-facing admin
    // console (users/invitations/timetable/settings).
    id: "principal",
    label: "Principal",
    to: "/portal/principal",
    requiredPermission: PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS,
  },
  {
    // The school's own Studafy subscription (plan, seats, invoices, cancellation) — distinct from
    // "Finance", which is the school's *own* tuition billing to families and runs on the unrelated
    // `billing:*` permissions (see `packages/constants/src/permissions.ts`'s `FINANCE_PERMISSIONS`).
    // Gated on `organization:manageBilling`, the same permission every subscriptions route itself
    // requires (see `apps/api/src/modules/subscriptions/routes/billing-overview-routes.ts`).
    id: "billing",
    label: "Billing",
    to: "/portal/billing",
    requiredPermission: PERMISSIONS.ORGANIZATION_MANAGE_BILLING,
  },
  {
    id: "finance",
    label: "Finance",
    to: "/portal/finance",
    // The same permission the finance report endpoints themselves require (see
    // apps/api/src/modules/finance/reports/routes.ts) — held by FINANCE and ORG_ADMIN.
    requiredPermission: PERMISSIONS.REPORT_VIEW_FINANCIAL,
  },
  {
    id: "approvals",
    label: "Approvals",
    to: "/portal/approvals",
    requiredPermission: PERMISSIONS.APPROVAL_REVIEW,
  },
  { id: "account", label: "Account", to: "/account" },
];

/** Narrows `PORTAL_NAV_ITEMS` to the ones a session holding `permissions` is allowed to see. */
export function visiblePortalNavItems(
  permissions: ReadonlySet<Permission>,
): readonly PortalNavItem[] {
  return PORTAL_NAV_ITEMS.filter(
    (item) => item.requiredPermission === undefined || permissions.has(item.requiredPermission),
  );
}
