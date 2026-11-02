import { rankDestinations, splitKeywords, visibleDestinations } from "./destinations";
import { searchTokens } from "./normalize";

import type { SearchDestination, Translate } from "./destinations";
import type { HelpSearchHit, HelpSearchOptions } from "../help/articles";
import type { Permission } from "@studafy/constants";

/**
 * The palette's instant groups — "Go to" (pages), "Do" (actions) and "How to" (help articles) —
 * built on the client from the destinations registry and the bundled help catalogue, with no API
 * call. Record groups come from the API and are mapped by `result-groups.ts`; the palette shows
 * these three first, then the record types (docs/modules/search.md "The palette").
 */
export type LocalGroupId = "pages" | "actions" | "help";

export interface PaletteItem {
  /** Unique across the palette — the React key and the `aria-activedescendant` target id. */
  key: string;
  title: string;
  subtitle?: string;
  /** Absent for a record with nowhere this caller can open; shown, but not selectable. */
  href?: string;
}

export interface LocalGroup {
  id: LocalGroupId;
  items: PaletteItem[];
}

/** Rows per instant group. Records are capped by the API's `limit`. */
export const PAGE_GROUP_CAP = 4;
export const ACTION_GROUP_CAP = 4;
export const HELP_GROUP_CAP = 3;

/** `searchHelp` from `features/help/articles`, which the palette loads on open (it carries every
 * article's Markdown, so it stays out of the portal's entry bundle). */
export type HelpSearch = (query: string, options?: HelpSearchOptions) => HelpSearchHit[];

export interface LocalSearchContext {
  /** Absent until the help catalogue has loaded; "How to" stays empty until then. */
  searchHelp?: HelpSearch;
  permissions: ReadonlySet<Permission>;
  roles: readonly string[];
  /** Active-language translator, for display. */
  t: Translate;
  /** Every language to match in, active first (`searchTranslators()`). */
  translators: readonly Translate[];
  /** Show a help article's Arabic title and description. */
  arabic: boolean;
}

export function destinationItem(destination: SearchDestination, t: Translate): PaletteItem {
  return {
    key: `${destination.kind === "page" ? "pages" : "actions"}:${destination.id}`,
    title: t(destination.titleKey),
    subtitle: destination.whereKey ? t(destination.whereKey) : undefined,
    href: destination.to,
  };
}

export function helpHref(slug: string, headingSlug?: string | null): string {
  return headingSlug ? `/help/${slug}#${headingSlug}` : `/help/${slug}`;
}

/** The three instant groups for `query`, best match first in each, empty groups dropped. */
export function buildLocalGroups(query: string, context: LocalSearchContext): LocalGroup[] {
  const visible = visibleDestinations(context.permissions);
  const ranked = rankDestinations(query, visible, context.translators);
  const pages = ranked.filter((destination) => destination.kind === "page");
  const actions = ranked.filter((destination) => destination.kind === "action");
  const help = (context.searchHelp?.(query, { roles: context.roles }) ?? []).slice(
    0,
    HELP_GROUP_CAP,
  );

  const groups: LocalGroup[] = [
    {
      id: "pages",
      items: pages.slice(0, PAGE_GROUP_CAP).map((page) => destinationItem(page, context.t)),
    },
    {
      id: "actions",
      items: actions.slice(0, ACTION_GROUP_CAP).map((action) => destinationItem(action, context.t)),
    },
    {
      id: "help",
      items: help.map(({ article, heading }) => ({
        key: `help:${article.slug}${heading ? `#${heading.slug}` : ""}`,
        title: context.arabic ? article.titleAr : article.title,
        subtitle: heading?.text ?? (context.arabic ? article.descriptionAr : article.description),
        href: helpHref(article.slug, heading?.slug),
      })),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** Character bigrams of a normalized word, for the "did you mean" fallback below. */
function bigrams(word: string): string[] {
  const padded = ` ${word} `;
  const grams: string[] = [];
  for (let index = 0; index < padded.length - 1; index += 1)
    grams.push(padded.slice(index, index + 2));
  return grams;
}

/** Dice coefficient over character bigrams: 1 for the same word, 0 for nothing in common. */
function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = new Map<string, number>();
  for (const gram of bigrams(b)) right.set(gram, (right.get(gram) ?? 0) + 1);
  let shared = 0;
  for (const gram of left) {
    const count = right.get(gram) ?? 0;
    if (count > 0) {
      shared += 1;
      right.set(gram, count - 1);
    }
  }
  return (2 * shared) / (left.length + bigrams(b).length);
}

/** Below this, a registry entry is too unlike the query to offer as "closest". */
const CLOSEST_FLOOR = 0.45;

/**
 * For the "no results" state: the registry entries closest to a query that matched nothing, by
 * typo-tolerant word similarity against each entry's title and keywords in every language — so
 * "timtable" still offers Timetable. Only entries this session can open.
 */
export function closestDestinations(
  query: string,
  context: Pick<LocalSearchContext, "permissions" | "translators">,
  count = 3,
): SearchDestination[] {
  const queryWords = searchTokens(query);
  if (queryWords.length === 0) return [];
  const scored = visibleDestinations(context.permissions).map((destination) => {
    let best = 0;
    for (const translate of context.translators) {
      const words = [
        translate(destination.titleKey),
        ...splitKeywords(translate(destination.keywordsKey)),
      ].flatMap((phrase) => searchTokens(phrase));
      const score =
        queryWords.reduce(
          (sum, queryWord) =>
            sum + Math.max(0, ...words.map((word) => similarity(queryWord, word))),
          0,
        ) / queryWords.length;
      best = Math.max(best, score);
    }
    return { destination, score: best };
  });
  return scored
    .filter((entry) => entry.score >= CLOSEST_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((entry) => entry.destination);
}
