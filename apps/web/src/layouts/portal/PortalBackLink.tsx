import { Link, matchRoutes, useLocation } from "react-router-dom";

import { resolveRoleHome, useAuth } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { PORTAL_NAV_ITEMS } from "./nav-items";

import type { RouteObject } from "react-router-dom";

/**
 * The nearest ancestor of `pathname` that is a page of its own, or `null` when there is none below
 * `/portal`. Walks up one segment at a time, so a path whose direct parent has no page skips it:
 * `/portal/finance/adjustments/refunds` goes back to `/portal/finance`, `/portal/admin/students/42`
 * to `/portal/admin/students`.
 */
export function portalParentPath(routes: readonly RouteObject[], pathname: string): string | null {
  const segments = pathname.replace(/\/+$/, "").split("/");
  while (segments.length > 2) {
    segments.pop();
    const candidate = segments.join("/");
    const matches = matchRoutes([...routes], candidate);
    const leaf = matches?.at(-1)?.route;
    // A page is an index route or a pathed one; a catch-all ("*") or pathless layout is not.
    const isPage = leaf?.index === true || (leaf?.path !== undefined && !leaf.path.endsWith("*"));
    if (isPage) {
      return candidate;
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
