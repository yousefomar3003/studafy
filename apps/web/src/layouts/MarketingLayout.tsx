import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { MarketingFooter } from "./marketing/MarketingFooter";
import { MarketingHeader } from "./marketing/MarketingHeader";

const NAV_ID = "marketing-nav";

/**
 * Public marketing site shell: fixed header with primary nav, then the routed page and footer in a
 * scroll region below it (so the scrollbar starts under the header). `navOpen` only
 * matters at the narrow breakpoint (`marketing-shell.css` hides the toggle and always shows the nav
 * above that width); it also closes on every route change so a mobile visitor doesn't land on the
 * next page with the menu still open over it.
 */
export function MarketingLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  return (
    <div className="marketing-shell">
      <MarketingHeader
        navId={NAV_ID}
        navOpen={navOpen}
        onToggleNav={() => setNavOpen((current) => !current)}
      />
      <div className="marketing-shell__scroll" data-scroll-root="">
        <Outlet />
        <MarketingFooter />
      </div>
    </div>
  );
}
