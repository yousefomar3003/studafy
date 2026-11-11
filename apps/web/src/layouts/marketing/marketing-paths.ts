import { MARKETING_NAV_ITEMS } from "./nav-items";

// Every route that renders inside `MarketingLayout` (see `app/routes.tsx`): the nav pages, the
// public legal pages (linked from the footer, sign-up and app-store listings rather than the nav),
// and the school sign-up pages. marketing-paths.test.ts checks this against the route table, so a
// page added to MarketingLayout without being listed here fails the build instead of showing two
// navigation bars.
const MARKETING_PATHS = new Set(MARKETING_NAV_ITEMS.map((item) => item.to));
const MARKETING_PATH_PREFIXES = ["/privacy", "/terms", "/school-agreement", "/legal/", "/signup"];

/** Whether `pathname` is a public marketing page, which brings its own header and footer. */
export function isMarketingPath(pathname: string): boolean {
  return (
    MARKETING_PATHS.has(pathname) ||
    MARKETING_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}
