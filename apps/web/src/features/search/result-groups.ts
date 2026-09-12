import { materialIngestStatusLabel, studentStatusLabel, userStatusLabel } from "./labels";

import type {
  GlobalSearchResult,
  InvoiceSearchHit,
  StudentSearchHit,
  UserSearchHit,
} from "./queries";

export type SearchResultType = "students" | "users" | "invoices" | "materials";

export interface SearchResultItem {
  /** Unique across the whole palette (`${type}:${id}`) -- the React key and the
   * `aria-activedescendant` target id. */
  key: string;
  title: string;
  subtitle: string;
  /** Absent when the record has no page to link to yet (materials -- see the comment below).
   * A row with no `href` is still shown, but excluded from keyboard/click navigation. */
  href?: string;
}

export interface SearchResultGroup {
  type: SearchResultType;
  items: SearchResultItem[];
}

/** A `SearchResultItem` narrowed to the ones with somewhere to go -- see `href`'s doc comment. */
export type NavigableSearchResultItem = SearchResultItem & { href: string };

export function isNavigable(item: SearchResultItem): item is NavigableSearchResultItem {
  return item.href !== undefined;
}

function studentTitle(hit: StudentSearchHit): string {
  return hit.preferred_name ?? `${hit.first_name} ${hit.last_name}`;
}

function invoiceSubtitle(hit: InvoiceSearchHit): string {
  // Matches `InvoiceListPage`'s own amount rendering exactly, rather than reformatting through
  // `Intl.NumberFormat` -- `total_amount` is already the display string that page shows.
  const amount = `${hit.total_amount} ${hit.currency}`;
  return hit.student_name ? `${hit.student_name} · ${amount}` : amount;
}

function userTitle(hit: UserSearchHit): string {
  return hit.display_name ?? hit.email;
}

function userSubtitle(hit: UserSearchHit): string {
  const status = userStatusLabel(hit.status);
  return hit.display_name ? `${hit.email} · ${status}` : status;
}

/**
 * Maps the API's `GlobalSearchResult` (already grouped and role-scoped server-side) into display
 * rows, skipping any group with zero hits. Route targets:
 *
 * - Students -> their real profile page (`admin/students/:studentId`).
 * - Invoices -> their real detail page (`finance/invoices/:invoiceId`).
 * - Users -> there is no per-user detail route in the portal today (see `nav-items.ts`'s own rule,
 *   "only entries backed by a real route belong here"), so this deep-links into the real list page
 *   pre-filtered to this exact person (`UsersListPage` reads the `q` param) rather than a page that
 *   doesn't exist.
 * - Materials -> no portal page exists yet at all (list or detail --
 *   `apps/api/src/modules/academics/routes/material-routes.ts` is API-only so far). These rows are
 *   left with no `href` and rendered as read-only until a page ships.
 */
export function buildResultGroups(result: GlobalSearchResult): SearchResultGroup[] {
  const groups: SearchResultGroup[] = [
    {
      type: "students",
      items: result.results.students.map((hit) => ({
        key: `students:${hit.id}`,
        title: studentTitle(hit),
        subtitle: `${hit.admission_number} · ${studentStatusLabel(hit.status)}`,
        href: `/portal/admin/students/${hit.id}`,
      })),
    },
    {
      type: "users",
      items: result.results.users.map((hit) => ({
        key: `users:${hit.id}`,
        title: userTitle(hit),
        subtitle: userSubtitle(hit),
        href: `/portal/admin/users?q=${encodeURIComponent(hit.email)}`,
      })),
    },
    {
      type: "invoices",
      items: result.results.invoices.map((hit) => ({
        key: `invoices:${hit.id}`,
        title: hit.erpnext_docname,
        subtitle: invoiceSubtitle(hit),
        href: `/portal/finance/invoices/${hit.id}`,
      })),
    },
    {
      type: "materials",
      items: result.results.materials.map((hit) => ({
        key: `materials:${hit.id}`,
        title: hit.title,
        subtitle: materialIngestStatusLabel(hit.ingest_status),
      })),
    },
  ];

  return groups.filter((group) => group.items.length > 0);
}
