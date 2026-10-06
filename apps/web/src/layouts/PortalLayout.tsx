import { useState } from "react";
import { Outlet } from "react-router-dom";

import { PortalHeader } from "./portal/PortalHeader";
import { PortalSidebar } from "./portal/PortalSidebar";

const NAV_ID = "portal-nav";

/**
 * Authenticated portal shell: header (brand, notification bell, user menu) and permission-gated
 * sidebar nav around the routed page. The sidebar has two independent states because its resting
 * state differs by breakpoint (both layouts live in `portal-shell.css`):
 *   - narrow: an off-canvas drawer, closed by default, opened from the header's toggle and closed
 *     again when a link is followed (`drawerOpen`);
 *   - desktop: an in-grid column, expanded by default, that its own toggle at the top shrinks to an
 *     icon rail (`collapsed`).
 * The state lives here, above the routed page, so it survives navigation between portal pages.
 */
export function PortalLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="portal-shell" data-nav-collapsed={collapsed || undefined}>
      <PortalHeader
        navId={NAV_ID}
        navOpen={drawerOpen}
        onToggleNav={() => setDrawerOpen((current) => !current)}
      />
      <PortalSidebar
        navId={NAV_ID}
        open={drawerOpen}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((current) => !current)}
        onNavigate={() => setDrawerOpen(false)}
      />
      <div className="portal-content">
        <Outlet />
      </div>
    </div>
  );
}
