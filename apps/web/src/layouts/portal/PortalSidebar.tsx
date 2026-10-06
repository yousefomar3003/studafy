import { NavLink } from "react-router-dom";

import { ApprovalQueueBadge } from "../../components/ApprovalQueueBadge";
import { usePermissions } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { visiblePortalNavItems } from "./nav-items";
import { NavIcon } from "./NavIcon";

export interface PortalSidebarProps {
  /** DOM id the header's nav toggle points `aria-controls` at. */
  navId: string;
  /** Open on the narrow (drawer) layout. Has no effect at the desktop breakpoint (always visible). */
  open: boolean;
  /** Desktop only: shrinks the sidebar to an icon rail. Ignored at the drawer breakpoint. */
  collapsed?: boolean;
  /** Desktop only: renders the collapse/expand toggle at the top of the sidebar. */
  onToggleCollapsed?: () => void;
  /** Called when a nav link is followed, so the drawer can close behind it. */
  onNavigate?: () => void;
}

/**
 * Sidebar navigation, permission-gated per `nav-items.ts`: a menu item renders only when the
 * session holds its `requiredPermission` (undefined means every authenticated session). The pending
 * count next to "Approvals" reuses `ApprovalQueueBadge` rather than duplicating its query — it is
 * only mounted when that item is visible, so a session without `approval:review` never issues the
 * (otherwise 403) request.
 *
 * Collapsed, each label stays in the DOM but visually hidden, so the link keeps its accessible name;
 * `title` gives sighted mouse users the same name as a tooltip.
 */
export function PortalSidebar({
  navId,
  open,
  collapsed = false,
  onToggleCollapsed,
  onNavigate,
}: PortalSidebarProps) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const items = visiblePortalNavItems(permissions);
  const listId = `${navId}-list`;

  return (
    <nav
      id={navId}
      aria-label={t("nav.ariaLabel")}
      className="portal-sidebar"
      data-open={open || undefined}
      data-collapsed={collapsed || undefined}
    >
      {onToggleCollapsed && (
        <button
          type="button"
          className="portal-icon-button portal-sidebar__toggle"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={onToggleCollapsed}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M3 5.5h14M3 10h14M3 14.5h14" />
          </svg>
          <span className="sf-visually-hidden">{t("shell.toggleNav")}</span>
        </button>
      )}
      <ul id={listId} className="portal-nav">
        {items.map((item) => (
          <li key={item.id} className="portal-nav__item">
            <NavLink
              to={item.to}
              end
              title={collapsed ? t(item.labelKey) : undefined}
              onClick={onNavigate}
              className={({ isActive }) =>
                isActive ? "portal-nav__link portal-nav__link--active" : "portal-nav__link"
              }
            >
              <NavIcon id={item.id} />
              <span className="portal-nav__label">{t(item.labelKey)}</span>
            </NavLink>
            {item.id === "approvals" ? <ApprovalQueueBadge /> : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}
