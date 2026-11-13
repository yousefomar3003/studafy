import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, matchRoutes, useLocation } from "react-router-dom";

import { resolveRoleHome, useAuth } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { PORTAL_NAV_ITEMS } from "./nav-items";

import type { ReactNode } from "react";
import type { RouteObject } from "react-router-dom";

/** Where the open page wants Back to go, when the route tree alone can't tell. */
type BackTarget = { readonly to: string } | undefined;

const BackTargetContext = createContext<{
  readonly target: BackTarget;
  readonly setTarget: (target: BackTarget) => void;
}>({ target: undefined, setTarget: () => undefined });

/** Holds the open page's Back target for the shell's one Back link. */
export function PortalBackProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<BackTarget>(undefined);
  return (
    <BackTargetContext.Provider value={{ target, setTarget }}>
      {children}
    </BackTargetContext.Provider>
  );
}

/**
 * Points the shell's Back link at `to` while the calling page is open — for a page whose way back
 * depends on where it was opened from (a parent's record goes back to the student it was opened
 * from) or on its own state (an editor goes back to its list). Pages never draw a back link of their
 * own, so there is only ever one. `undefined` leaves the route tree's parent in place.
 */
export function usePortalBack(to: string | undefined): void {
  const { setTarget } = useContext(BackTargetContext);
  useEffect(() => {
    if (to === undefined) return undefined;
    setTarget({ to });
    return () => setTarget(undefined);
  }, [to, setTarget]);
}

/** A trailing splat: "principal/academic-setup/*" is a page at its base that routes its own tabs. */
const SPLAT = /\/\*$/;

/**
 * A page is an index route, a pathed one, or a section that routes its own sub-pages ("x/*", a
 * page at "x"). A bare catch-all ("*") or pathless layout is not.
 */
function isPage(route: RouteObject | undefined): boolean {
  return route?.index === true || (route?.path !== undefined && route.path !== "*");
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
    if (isPage(route)) patterns.add(pattern.replace(SPLAT, "") || "/");
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
function leafPatternOf(routes: readonly RouteObject[], pathname: string): string | undefined {
  return matchRoutes([...routes], pathname)?.reduce(
    (pattern, match) => joinPattern(pattern, match.route.path),
    "",
  );
}

/**
 * The page `pathname` belongs to: itself, or for a URL inside a section that routes its own tabs
 * ("academic-setup/*") the section's base, so moving between those tabs stays on one page.
 */
export function pageKeyOf(routes: readonly RouteObject[], pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  const leafPattern = leafPatternOf(routes, path);
  if (leafPattern === undefined || !SPLAT.test(leafPattern)) return path;
  const baseLength = leafPattern.replace(SPLAT, "").split("/").length;
  return path.split("/").slice(0, baseLength).join("/");
}

export function portalParentPath(routes: readonly RouteObject[], pathname: string): string | null {
  let segments = pathname.replace(/\/+$/, "").split("/");
  const leafPattern = leafPatternOf(routes, segments.join("/"));
  // A section that routes its own sub-pages ("academic-setup/*"): its tabs are the section itself,
  // so every URL under it goes back from the section's base, not to the section's own tabs.
  const sectionBase = leafPattern !== undefined && SPLAT.test(leafPattern);
  const patternSegments = sectionBase
    ? leafPattern.replace(SPLAT, "").split("/")
    : leafPattern?.split("/");
  if (sectionBase && patternSegments) segments = segments.slice(0, patternSegments.length);
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
 * Tabs that are routed as pages of their own but are the sidebar page itself, seen through its tab
 * bar (License: Overview / Seats / Quotes / Invoices / Storage). A quote or an invoice below them is
 * a page of its own again.
 */
const SIDEBAR_TABS: ReadonlySet<string> = new Set([
  "/portal/license/seats",
  "/portal/license/quotes",
  "/portal/license/invoices",
  "/portal/license/storage",
]);

/** A page the sidebar links to (Home, Notifications, Principal, Approvals, Account, …) or one of its tabs. */
export function isSidebarPage(path: string): boolean {
  return SIDEBAR_TABS.has(path) || PORTAL_NAV_ITEMS.some((item) => item.to === path);
}

/**
 * Where Back goes from `path` (no trailing slash) for a user whose home is `home`, or `null` on the
 * pages the sidebar itself opens — the home, every sidebar item, and `/portal`, which only forwards
 * to the home — since the sidebar is the way between those. Any page below them goes one level up,
 * or to the home when its nearest parent is just `/portal`.
 */
export function portalBackPath(
  routes: readonly RouteObject[],
  path: string,
  home: string,
): string | null {
  if (path === home || path === "/portal" || isSidebarPage(path)) return null;
  const parent = portalParentPath(routes, path);
  return parent === null || parent === "/portal" ? home : parent;
}

/** One page in the trail of pages opened since the last sidebar page. */
export interface TrailEntry {
  /** The page (`pageKeyOf`): every tab of a section shares one. */
  readonly key: string;
  /** Exactly where the user was, query string included, to go back to. */
  readonly href: string;
}

/**
 * The trail after opening `entry`. A sidebar page (`start`) begins a new trail; the same page again
 * (another tab, another filter) replaces the last entry; the page before the last one is a step back
 * and drops the last entry; anything else is a step forward.
 */
export function stepTrail(
  trail: readonly TrailEntry[],
  entry: TrailEntry,
  start: boolean,
): readonly TrailEntry[] {
  if (start) return [entry];
  if (trail.at(-1)?.key === entry.key) return [...trail.slice(0, -1), entry];
  if (trail.at(-2)?.key === entry.key) return [...trail.slice(0, -2), entry];
  return [...trail, entry];
}

/** A form (".../new", ".../edit") is done once left, so Back never reopens it. */
const FORM_PAGE = /\/(new|edit)$/;

/**
 * The page the user came to `trail`'s last entry from, when Back may return there: not a form they
 * already submitted, and not a page below the current one (a deleted item's page, say).
 */
export function trailBackHref(trail: readonly TrailEntry[]): string | undefined {
  const current = trail.at(-1);
  const previous = trail.at(-2);
  if (!current || !previous) return undefined;
  if (FORM_PAGE.test(previous.key) || previous.key.startsWith(`${current.key}/`)) return undefined;
  return previous.href;
}

/**
 * "Back" link above every portal page below a sidebar page. It goes to the page the user came from
 * — Import data → Past imports goes back to Import data, though Past imports sits under Students — and,
 * when there is none to go to (the page was opened from a bookmark, or reloaded), to the page's own
 * Back target (`usePortalBack`) or else the page one level up. The sidebar pages themselves have the
 * sidebar for that, so they get none. One link here instead of each page hand-rolling its own keeps
 * the label, place and target the same everywhere.
 */
export function PortalBackLink({ routes }: { routes: () => readonly RouteObject[] }) {
  const { pathname, search } = useLocation();
  const { roles } = useAuth();
  const { target } = useContext(BackTargetContext);
  const trailRef = useRef<readonly TrailEntry[]>([]);

  const path = pathname.replace(/\/+$/, "") || "/";
  const home = resolveRoleHome(roles);
  const fallback = portalBackPath(routes(), path, home);
  const start = fallback === null;
  // Worked out while rendering (a pure step, so a re-render lands on the same trail) and kept once
  // committed, so the link is right on the very first render of each page.
  const trail = stepTrail(
    trailRef.current,
    { key: pageKeyOf(routes(), path), href: `${path}${search}` },
    start,
  );
  useEffect(() => {
    trailRef.current = trail;
  });

  if (start) return null;
  const back = trailBackHref(trail) ?? target?.to ?? fallback;
  return <BackLink to={back} />;
}

/** The "← Back" link itself, the same in the portal and on the account pages. */
export function BackLink({ to }: { to: string }) {
  const { t } = useTranslation();
  return (
    <Link to={to} className="portal-back-link">
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
