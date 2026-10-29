import { isSearchType } from "./queries";

import type { SearchType } from "./queries";

/**
 * `in:<type>` scopes a palette query to one record type ("in:invoices inv-00"), the same filter the
 * full results page's chips set. A few spoken aliases are accepted alongside the API's own type
 * names; anything else after `in:` is left in the text, so it is simply searched for.
 */
const ALIASES: Readonly<Record<string, SearchType>> = {
  student: "students",
  user: "users",
  people: "users",
  invoice: "invoices",
  material: "materials",
  class: "classes",
  section: "sections",
  subject: "subjects",
  grades: "grade_levels",
  years: "academic_years",
  term: "terms",
  room: "rooms",
  family: "families",
  announcement: "announcements",
  event: "events",
  calendar: "events",
  incident: "incidents",
  discipline: "incidents",
  evaluation: "evaluations",
  fees: "fee_structures",
  scholarship: "scholarships",
  expense: "expenses",
  notification: "notifications",
};

const SCOPE = /(?:^|\s)in:([a-z_]+)(?=\s|$)/i;

export interface ScopedQuery {
  /** The query with any recognized `in:<type>` removed, trimmed. */
  text: string;
  type?: SearchType;
}

export function parseScopedQuery(raw: string): ScopedQuery {
  const match = SCOPE.exec(raw);
  if (match) {
    const name = match[1]!.toLowerCase();
    const type = isSearchType(name) ? name : ALIASES[name];
    if (type) {
      const text = `${raw.slice(0, match.index)} ${raw.slice(match.index + match[0].length)}`;
      return { text: text.replace(/\s+/g, " ").trim(), type };
    }
  }
  return { text: raw.replace(/\s+/g, " ").trim() };
}

/** The full results page for `query`, optionally filtered to one type. */
export function searchResultsHref(query: string, type?: SearchType, page?: number): string {
  const params = new URLSearchParams({ q: query });
  if (type) params.set("type", type);
  if (page && page > 1) params.set("page", String(page));
  return `/portal/search?${params.toString()}`;
}
