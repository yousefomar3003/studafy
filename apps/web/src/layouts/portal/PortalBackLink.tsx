import { Link, matchRoutes, useLocation } from "react-router-dom";

import { resolveRoleHome, useAuth } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { PORTAL_NAV_ITEMS } from "./nav-items";

import type { RouteObject } from "react-router-dom";

/** A page is an index route or a pathed one; a catch-all ("*") or pathless layout is not. */
function isPage(route: RouteObject | undefined): boolean {
  return route?.index === true || (route?.path !== undefined && !route.path.endsWith("*"));
}

function joinPattern(base: string, path: string | undefined): string {
  if (path === undefined) return base;
  const joined = path.startsWith("/") ? path : `${base}/${path}`;
  return joined.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
}

/** The full pattern ("/portal/finance/invoices/:invoiceId") of every page in the route tree. */
function pagePatterns(routes: readonly RouteObject[], base = ""): Set<string> {
  const patterns = new Set<string>();
  for (const route of routes) {
    const pattern = joinPattern(base, route.path);
    if (isPage(route)) patterns.add(pattern || "/");
    for (const child of pagePatterns(route.children ?? [], pattern)) patterns.add(child);
  }
  return patterns;
}

/**
 * The nearest ancestor of `pathname` that is a page of its own, or `null` when there is none below
 * `/portal`. Walks up the *route pattern* `pathname` matched, one segment at a time, so a path whose
 * direct parent has no page skips it: `/portal/finance/adjustments/refunds` goes back to
 * `/portal/finance`, `/portal/admin/students/42` to `/portal/admin/students`. Walking the pattern
 * rather than the URL keeps a sibling's parameter from claiming a static segment:
 * `/portal/finance/invoices/batches/new` goes back to `/portal/finance/invoices`, not to
 * `/portal/finance/invoices/batches`, which only `finance/invoices/:invoiceId` would match.
 */
export function portalParentPath(routes: readonly RouteObject[], pathname: string): string | null {
  const segments = pathname.replace(/\/+$/, "").split("/");
  const matches = matchRoutes([...routes], segments.join("/"));
  const leafPattern = matches?.reduce(
    (pattern, match) => joinPattern(pattern, match.route.path),
    "",
  );
  const patternSegments = leafPattern?.split("/");
  // A URL no route matches has no pattern to walk; it gets no Back link.
  if (!patternSegments || patternSegments.length !== segments.length) return null;

  const pages = pagePatterns(routes);
  for (let length = segments.length - 1; length >= 2; length -= 1) {
    if (pages.has(patternSegments.slice(0, length).join("/"))) {
      return segments.slice(0, length).join("/");
    }
  }
  return null;
}

/**
 * "Back" link above every portal page that sits below a section — a list's detail page, a form, a
 * section's sub-page — pointing at the page one level up. Top-level pages (each sidebar item and the
 * role's own home) have the sidebar for that, so they get none. One link here instead of each page
 * hand-rolling its own keeps the label, place and target the same everywhere.
 */
export function PortalBackLink({ routes }: { routes: () => readonly RouteObject[] }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { roles } = useAuth();

  const path = pathname.replace(/\/+$/, "") || "/";
  const topLevel =
    path === resolveRoleHome(roles) || PORTAL_NAV_ITEMS.some((item) => item.to === path);
  const parent = topLevel ? null : portalParentPath(routes(), path);
  if (!parent) return null;

  return (
    <Link to={parent} className="portal-back-link">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M10 3.5 5.5 8l4.5 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {t("shell.back")}
    </Link>
  );
}
