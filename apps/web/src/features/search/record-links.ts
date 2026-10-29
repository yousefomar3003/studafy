import { PERMISSIONS } from "@studafy/constants";

import type { GlobalSearchResult, SearchType } from "./queries";
import type { Permission } from "@studafy/constants";

/**
 * Where a record hit opens, for this caller — the one place that decides it (docs/modules/search.md
 * "Role-aware links"). Each type lists its candidate pages in preference order, each with the exact
 * `RequirePermission` of its route (pinned by `record-links.test.ts` against the real route tree);
 * the first one the caller holds wins. A hit with no openable candidate has no link: the palette
 * still shows it, read-only.
 *
 * Preference order puts the page that shows the record itself before a list it merely appears in,
 * and the admin console before the principal's (an org admin, who holds both, lands in their own).
 * This only picks a link: the route guard and the API stay the real gate.
 */

type Results = GlobalSearchResult["results"];
export type SearchHitOf<T extends SearchType> = Results[T][number];

interface Candidate<T extends SearchType> {
  /** Exactly the route's `RequirePermission`; omitted for a route without one. */
  permission?: Permission;
  /** Narrows who is sent here (never widens): the admin calendar is for the admin console's users. */
  alsoRequires?: Permission;
  href: (hit: SearchHitOf<T>) => string;
}

type CandidateTable = { [T in SearchType]: readonly Candidate<T>[] };

const P = PERMISSIONS;
const SETUP = "/portal/principal/academic-setup";

const q = (value: string | null | undefined) => encodeURIComponent(value ?? "");

export const RECORD_LINK_CANDIDATES: CandidateTable = {
  students: [
    {
      permission: P.ORGANIZATION_MANAGE_SETTINGS,
      href: (hit) => `/portal/admin/students/${hit.id}`,
    },
    {
      permission: P.PRINCIPAL_DASHBOARD_VIEW,
      href: (hit) => `/portal/principal/students/${hit.id}`,
    },
    {
      permission: P.ATTENDANCE_DASHBOARD_VIEW,
      href: (hit) => `/portal/attendance/students/${hit.id}`,
    },
  ],
  // No per-person page: the admin's user list, filtered to exactly this person (it reads `q`).
  users: [
    {
      permission: P.ORGANIZATION_MANAGE_SETTINGS,
      href: (hit) => `/portal/admin/users?q=${q(hit.email ?? hit.display_name)}`,
    },
  ],
  invoices: [{ permission: P.BILLING_READ, href: (hit) => `/portal/finance/invoices/${hit.id}` }],
  // No portal page for a material yet; read-only, as before.
  materials: [],
  classes: [
    { permission: P.PRINCIPAL_DASHBOARD_VIEW, href: () => "/portal/principal/classes" },
    {
      permission: P.ATTENDANCE_DASHBOARD_VIEW,
      href: (hit) => `/portal/attendance/register/${hit.id}`,
    },
  ],
  sections: [{ permission: P.TIMETABLE_MANAGE, href: () => "/portal/principal/sections" }],
  subjects: [{ permission: P.ACADEMIC_CONFIG_READ, href: () => `${SETUP}/subjects` }],
  grade_levels: [{ permission: P.TIMETABLE_MANAGE, href: () => "/portal/principal/sections" }],
  // Years and terms are defined in the setup wizard; their grading setup lives in academic setup.
  academic_years: [
    { permission: P.ACADEMIC_CONFIG_READ, href: () => SETUP },
    { permission: P.ORGANIZATION_MANAGE_SETTINGS, href: () => "/onboarding/setup" },
  ],
  terms: [
    { permission: P.ACADEMIC_CONFIG_READ, href: () => SETUP },
    { permission: P.ORGANIZATION_MANAGE_SETTINGS, href: () => "/onboarding/setup" },
  ],
  // Rooms are assigned on the timetable; there is no room page of its own.
  rooms: [
    { permission: P.ORGANIZATION_MANAGE_SETTINGS, href: () => "/portal/admin/timetable" },
    { permission: P.PRINCIPAL_DASHBOARD_VIEW, href: () => "/portal/principal/timetable" },
  ],
  families: [{ permission: P.BILLING_READ, href: (hit) => `/portal/finance/families/${hit.id}` }],
  announcements: [{ permission: P.NOTIFICATION_MANAGE, href: () => "/portal/admin/announcements" }],
  events: [
    {
      permission: P.CALENDAR_EVENT_READ,
      alsoRequires: P.ORGANIZATION_MANAGE_SETTINGS,
      href: () => "/portal/admin/calendar",
    },
    { permission: P.CALENDAR_EVENT_READ, href: () => "/portal/principal/calendar" },
  ],
  incidents: [
    {
      permission: P.PRINCIPAL_DASHBOARD_VIEW,
      href: (hit) => `/portal/principal/discipline/${hit.id}`,
    },
  ],
  evaluations: [
    {
      permission: P.PRINCIPAL_DASHBOARD_VIEW,
      href: (hit) => `/portal/principal/evaluations/${hit.id}`,
    },
  ],
  fee_structures: [{ permission: P.BILLING_UPDATE, href: () => "/portal/finance/fees" }],
  scholarships: [{ permission: P.BILLING_READ, href: () => "/portal/finance/scholarships" }],
  expenses: [{ permission: P.BILLING_READ, href: (hit) => `/portal/finance/expenses/${hit.id}` }],
  // The caller's own inbox; open to every session.
  notifications: [{ href: () => "/portal/notifications" }],
};

function holds(candidate: Candidate<SearchType>, permissions: ReadonlySet<Permission>): boolean {
  return (
    (candidate.permission === undefined || permissions.has(candidate.permission)) &&
    (candidate.alsoRequires === undefined || permissions.has(candidate.alsoRequires))
  );
}

/** The page `hit` of `type` opens for a caller holding `permissions`, or undefined for none. */
export function recordHref<T extends SearchType>(
  type: T,
  hit: SearchHitOf<T>,
  permissions: ReadonlySet<Permission>,
): string | undefined {
  const candidates = RECORD_LINK_CANDIDATES[type] as readonly Candidate<T>[];
  const chosen = candidates.find((candidate) =>
    holds(candidate as Candidate<SearchType>, permissions),
  );
  return chosen?.href(hit);
}
