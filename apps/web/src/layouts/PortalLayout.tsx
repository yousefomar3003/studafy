import { useState } from "react";
import { Outlet } from "react-router-dom";

import { PortalHeader } from "./portal/PortalHeader";
import { PortalSidebar } from "./portal/PortalSidebar";

const NAV_ID = "portal-nav";

/**
 * Authenticated portal shell: header (brand, notification bell, user menu) and permission-gated
 * sidebar nav around the routed page. `navOpen` only matters at the narrow breakpoint — the header's
 * toggle and the sidebar's off-canvas behavior are both defined in `portal-shell.css`; above that
 * breakpoint the sidebar is always visible and this state is inert.
 */
export function PortalLayout() {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="portal-shell">
      <PortalHeader
        navId={NAV_ID}
        navOpen={navOpen}
        onToggleNav={() => setNavOpen((current) => !current)}
      />
      <PortalSidebar navId={NAV_ID} open={navOpen} />
      <div className="portal-content">
        <Outlet />
      </div>
    </div>
  );
}
