import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { MarketingFooter } from "./marketing/MarketingFooter";
import { MarketingHeader } from "./marketing/MarketingHeader";
import { useReveal } from "./marketing/use-reveal";

const NAV_ID = "marketing-nav";

/**
 * Public marketing site shell: the header bar with primary nav, then the routed page and footer in a
 * scroll region below it (so the scrollbar starts under the header). Content rises into place as it
 * scrolls into view (use-reveal.ts). `navOpen` only
 * matters at the narrow breakpoint (`marketing-shell.css` hides the toggle and always shows the nav
 * above that width); it also closes on every route change so a mobile visitor doesn't land on the
 * next page with the menu still open over it.
 */
export function MarketingLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  useReveal(scrollRef);

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
      <div ref={scrollRef} className="marketing-shell__scroll" data-scroll-root="">
        <Outlet />
        <MarketingFooter />
      </div>
    </div>
  );
}
