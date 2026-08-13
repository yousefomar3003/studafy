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
