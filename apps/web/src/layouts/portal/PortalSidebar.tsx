import { NavLink } from "react-router-dom";

import { ApprovalQueueBadge } from "../../components/ApprovalQueueBadge";
import { usePermissions } from "../../lib/auth";

import { visiblePortalNavItems } from "./nav-items";

export interface PortalSidebarProps {
  /** DOM id the header's nav toggle points `aria-controls` at. */
  navId: string;
  /** Open on the narrow (drawer) layout. Has no effect at the desktop breakpoint (always visible). */
  open: boolean;
}

/**
 * Sidebar navigation, permission-gated per `nav-items.ts`: a menu item renders only when the
 * session holds its `requiredPermission` (undefined means every authenticated session). The pending
 * count next to "Approvals" reuses `ApprovalQueueBadge` rather than duplicating its query — it is
 * only mounted when that item is visible, so a session without `approval:review` never issues the
 * (otherwise 403) request.
 */
export function PortalSidebar({ navId, open }: PortalSidebarProps) {
  const permissions = usePermissions();
  const items = visiblePortalNavItems(permissions);

  return (
    <nav id={navId} aria-label="Portal" className="portal-sidebar" data-open={open || undefined}>
      <ul className="portal-nav">
        {items.map((item) => (
          <li key={item.id} className="portal-nav__item">
            <NavLink
              to={item.to}
              end
              className={({ isActive }) =>
                isActive ? "portal-nav__link portal-nav__link--active" : "portal-nav__link"
              }
            >
              {item.label}
            </NavLink>
            {item.id === "approvals" ? <ApprovalQueueBadge /> : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}
