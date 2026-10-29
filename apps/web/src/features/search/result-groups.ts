import { materialIngestStatusLabel, studentStatusLabel, userStatusLabel } from "./labels";
import { SEARCH_TYPES } from "./queries";
import { recordHref } from "./record-links";

import type { PaletteItem } from "./palette-groups";
import type { GlobalSearchResult, SearchType } from "./queries";
import type { SearchHitOf } from "./record-links";
import type { Permission } from "@studafy/constants";

export type SearchResultType = SearchType;

/** A palette row; `href` is absent when this caller has no page to open the record on. */
export type SearchResultItem = PaletteItem;

export interface SearchResultGroup {
  type: SearchResultType;
  items: SearchResultItem[];
  /** Every match of this type (the API's `totals`), for "See all N" when it exceeds the rows. */
  total: number;
}

/** A row narrowed to the ones with somewhere to go -- see `href`'s doc comment. */
export type NavigableSearchResultItem = SearchResultItem & { href: string };

export function isNavigable(item: SearchResultItem): item is NavigableSearchResultItem {
  return item.href !== undefined;
}

/** Label translator — the palette passes its hook `t`; tests and other callers can omit it. */
type Translate = (key: string) => string;

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);
const join = (...parts: (string | null | undefined | false)[]) =>
  parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
const span = (from: string | null | undefined, to: string | null | undefined) =>
  from && to ? `${day(from)} – ${day(to)}` : day(from);
const money = (amount: string | null | undefined, currency: string | null | undefined) =>
  amount ? join(amount, currency) : null;

type Describe<T extends SearchType> = (
  hit: SearchHitOf<T>,
  t?: Translate,
) => { title: string; subtitle: string };

/**
 * Title and secondary line per record type. Kept to the hit's own display fields (names, codes,
 * dates, amounts) — never anything a list page would not show.
 */
const DESCRIBE: { [T in SearchType]: Describe<T> } = {
  students: (hit, t) => ({
    title: hit.preferred_name ?? `${hit.first_name} ${hit.last_name}`,
    subtitle: `${hit.admission_number} · ${studentStatusLabel(hit.status, t)}`,
  }),
  users: (hit, t) => {
    const status = userStatusLabel(hit.status, t);
    return {
      title: hit.display_name ?? hit.email ?? hit.id,
      subtitle: hit.display_name ? `${hit.email} · ${status}` : status,
    };
  },
  invoices: (hit) => ({
    title: hit.erpnext_docname,
    // `total_amount` is already the display string `InvoiceListPage` shows.
    subtitle: join(hit.student_name, `${hit.total_amount} ${hit.currency}`),
  }),
  materials: (hit, t) => ({
    title: hit.title,
    subtitle: materialIngestStatusLabel(hit.ingest_status, t),
  }),
  classes: (hit) => ({ title: hit.code, subtitle: join(hit.course_name) }),
  sections: (hit) => ({ title: hit.name, subtitle: join(hit.grade_level_name) }),
  subjects: (hit) => ({ title: hit.name, subtitle: join(hit.code) }),
  grade_levels: (hit) => ({ title: hit.name, subtitle: "" }),
  academic_years: (hit) => ({
    title: hit.name,
    subtitle: join(hit.code, span(hit.starts_on, hit.ends_on)),
  }),
  terms: (hit) => ({
    title: hit.name,
    subtitle: join(hit.academic_year_name, span(hit.starts_on, hit.ends_on)),
  }),
  rooms: (hit) => ({ title: hit.name, subtitle: join(hit.code, hit.building) }),
  families: (hit) => ({ title: hit.display_name, subtitle: join(hit.primary_parent_name) }),
  announcements: (hit) => ({
    title: hit.title,
    subtitle: join(day(hit.published_at ?? hit.scheduled_at)),
  }),
  events: (hit) => ({ title: hit.title, subtitle: join(span(hit.starts_on, hit.ends_on)) }),
  incidents: (hit) => ({
    title: hit.title,
    subtitle: join(hit.student_name, day(hit.incident_at)),
  }),
  evaluations: (hit) => ({
    title: hit.teacher_name ?? hit.teacher_id,
    subtitle: join(day(hit.evaluated_at)),
  }),
  fee_structures: (hit) => ({
    title: hit.title,
    subtitle: join(money(hit.total_amount, hit.currency), hit.academic_year_name),
  }),
  scholarships: (hit) => ({
    title: hit.name,
    subtitle: join(
      hit.percentage !== null && hit.percentage !== undefined
        ? `${hit.percentage}%`
        : money(hit.amount, hit.currency),
    ),
  }),
  expenses: (hit) => ({
    title: hit.vendor ?? hit.erpnext_docname ?? hit.id,
    subtitle: join(money(hit.amount, hit.currency), day(hit.expense_date)),
  }),
  notifications: (hit) => ({ title: hit.title, subtitle: join(day(hit.created_at)) }),
};

function describe<T extends SearchType>(type: T, hit: SearchHitOf<T>, t?: Translate) {
  return (DESCRIBE[type] as Describe<T>)(hit, t);
}

/**
 * Maps the API's `GlobalSearchResult` (already grouped and role-scoped server-side) into display
 * rows in the API's canonical type order, skipping any type with zero hits. Each row's link is
 * whatever page this caller can open it on (`recordHref`), or none.
 */
export function buildResultGroups(
  result: GlobalSearchResult,
  permissions: ReadonlySet<Permission>,
  t?: Translate,
): SearchResultGroup[] {
  const groups: SearchResultGroup[] = [];
  for (const type of SEARCH_TYPES) {
    const hits = (result.results[type] ?? []) as readonly SearchHitOf<typeof type>[];
    if (hits.length === 0) continue;
    groups.push({
      type,
      total: Math.max(result.totals?.[type] ?? hits.length, hits.length),
      items: hits.map((hit) => ({
        key: `${type}:${hit.id}`,
        ...describe(type, hit, t),
        href: recordHref(type, hit, permissions),
      })),
    });
  }
  return groups;
}
