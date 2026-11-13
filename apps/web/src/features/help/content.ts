/**
 * Help center content registry — pure parse-and-search logic for everything the `/help` routes
 * render.
 *
 * Articles are authored as Markdown in `/docs/help` (one file per article, parent directory =
 * category slug — see `/docs/help/README.md` for the authoring rules). `./articles.ts` is the only
 * browser-only module that imports the raw files (through Vite's `?raw`); this module stays free of
 * Vite-isms so it can be unit-tested under `bun test` and imported from anywhere (see
 * `content.test.ts`).
 *
 * Everything here is a pure function of its arguments.
 */
import { ROLES } from "@studafy/constants";

import { searchTokens } from "../search/normalize";

import type { CategorySlug, HelpArticle, HelpSearchHit } from "./content.types";
import type { Role } from "@studafy/constants";

/** Category slugs in display order. A Markdown file whose parent directory is not listed here is
 * not part of the published site (currently just `/docs/help/README.md`). */
export const CATEGORY_ORDER: readonly CategorySlug[] = [
  "getting-started",
  "academics",
  "finance",
  "billing",
];

export const CATEGORY_LABELS: Readonly<Record<CategorySlug, string>> = {
  "getting-started": "Getting started",
  academics: "Academics",
  finance: "Finance",
  billing: "Billing",
};

export function categoryLabel(category: CategorySlug): string {
  return CATEGORY_LABELS[category];
}

/**
 * Deterministic heading/identifier slug, shared by the Markdown renderer (heading ids) and the
 * onboarding wizard's step links. "Step 5: Student import" → `step-5-student-import`.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface RawArticle {
  /** Module path passed to the build, e.g. `@docs/help/getting-started/onboarding-guide.md`. */
  path: string;
  /** Raw file contents, including frontmatter. */
  raw: string;
}

interface Frontmatter {
  title: string;
  description: string;
  keywords: string[];
  titleAr: string;
  descriptionAr: string;
  keywordsAr: string[];
  roles: Role[];
  action: string | null;
  order: number;
  publish: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** `key: [a, "b", c]` — the canonical single-line list form. */
const LIST_KEY_RE = /^([A-Za-z_]+):\s*\[(.*)\]$/;
/** A list that Prettier wrapped across lines (`key:\n  [\n    "a",\n  ]`). */
const LIST_BLOCK_RE = /^([A-Za-z_]+):\s*\[([^\]]*)\]/gm;
const STRING_KEY_RE = /^([A-Za-z_]+):\s*(.+)$/;
const NUMBER_KEY_RE = /^([A-Za-z_]+):\s*(\d+)$/;
/** Registry action ids (`apps/web/src/features/search/destinations.ts`) are kebab-case. Only the
 * shape is checked here; the registry owns the list of real ids. */
const ACTION_RE = /^[a-z0-9-]+$/;
const KNOWN_ROLES: ReadonlySet<string> = new Set(Object.values(ROLES));

const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, "$1");

function parseList(values: string): string[] {
  return values
    .split(",")
    .map(unquote)
    .filter((value) => value.length > 0);
}

function parseFrontmatter(raw: string, slug: string): { frontmatter: Frontmatter; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error(`help article "${slug}" is missing its frontmatter block`);
  }

  const frontmatter: Frontmatter = {
    title: slug,
    description: "",
    keywords: [],
    titleAr: "",
    descriptionAr: "",
    keywordsAr: [],
    roles: [],
    action: null,
    order: 0,
    publish: true,
  };
  // Prettier wraps long list values across lines; flatten every such list so the line-oriented
  // parser below only ever sees the canonical single-line `key: [...]` form.
  const flattenedFrontmatter = match[1].replace(
    LIST_BLOCK_RE,
    (_, key: string, values: string) => `${key}: [${values.replace(/\s+/g, " ").trim()}]`,
  );
  for (const line of flattenedFrontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const list = LIST_KEY_RE.exec(trimmed);
    if (list) {
      const values = parseList(list[2]);
      if (list[1] === "keywords") frontmatter.keywords = values;
      else if (list[1] === "keywords_ar") frontmatter.keywordsAr = values;
      else if (list[1] === "roles") {
        const unknown = values.filter((role) => !KNOWN_ROLES.has(role));
        if (unknown.length > 0) {
          throw new Error(`help article "${slug}" names unknown roles: ${unknown.join(", ")}`);
        }
        frontmatter.roles = [...new Set(values)] as Role[];
      } else {
        throw new Error(`help article "${slug}" has an unsupported frontmatter line: "${trimmed}"`);
      }
      continue;
    }

    const number = NUMBER_KEY_RE.exec(trimmed);
    if (number) {
      const value = Number(number[2]);
      if (number[1] === "order") frontmatter.order = value;
      else if (number[1] === "publish") frontmatter.publish = value === 1;
      else {
        throw new Error(`help article "${slug}" has an unsupported frontmatter line: "${trimmed}"`);
      }
      continue;
    }

    const string = STRING_KEY_RE.exec(trimmed);
    if (string) {
      const [, key, rawValue] = string;
      const value = unquote(rawValue);
      if (key === "title") frontmatter.title = value;
      else if (key === "description") frontmatter.description = value;
      else if (key === "title_ar") frontmatter.titleAr = value;
      else if (key === "description_ar") frontmatter.descriptionAr = value;
      else if (key === "action") {
        if (!ACTION_RE.test(value)) {
          throw new Error(`help article "${slug}" has an invalid action id: "${value}"`);
        }
        frontmatter.action = value;
      } else if (key === "publish") {
        if (value !== "true" && value !== "false") {
          throw new Error(`help article "${slug}" has an invalid publish value: "${value}"`);
        }
        frontmatter.publish = value === "true";
      } else {
        throw new Error(`help article "${slug}" has an unsupported frontmatter line: "${trimmed}"`);
      }
      continue;
    }

    throw new Error(`help article "${slug}" has an unsupported frontmatter line: "${trimmed}"`);
  }

  return { frontmatter, body: raw.slice(match[0].length) };
}

/** Published articles must be findable in Arabic: the palette searches both languages. */
function assertArabicFrontmatter(frontmatter: Frontmatter, slug: string): void {
  const missing = [
    frontmatter.titleAr ? null : "title_ar",
    frontmatter.descriptionAr ? null : "description_ar",
    frontmatter.keywordsAr.length > 0 ? null : "keywords_ar",
  ].filter((key): key is string => key !== null);
  if (missing.length > 0) {
    throw new Error(
      `help article "${slug}" is published but missing Arabic frontmatter: ${missing.join(", ")}`,
    );
  }
}

function parsePath(path: string): { category: CategorySlug | null; slug: string } {
  const normalized = path.replace(/\\/g, "/");
  const relative = normalized.replace(/^.*docs\/help\//, "").replace(/\.md$/, "");
  const separator = relative.lastIndexOf("/");
  const category = relative.slice(0, separator);
  const slug = relative.slice(separator + 1);
  const isKnownCategory = (CATEGORY_ORDER as readonly string[]).includes(category);
  return { category: isKnownCategory ? (category as CategorySlug) : null, slug };
}

/**
 * Pure registry builder. Throws on an authoring error (bad frontmatter, unsupported line) rather
 * than silently dropping content — a help article with a typo should fail the build, not vanish.
 */
export function buildArticles(rawArticles: readonly RawArticle[]): HelpArticle[] {
  const articles: HelpArticle[] = [];
  for (const { path, raw } of rawArticles) {
    const { category, slug } = parsePath(path);
    if (!category) continue; // e.g. docs/help/README.md — the authoring guide, not an article.

    const { frontmatter, body } = parseFrontmatter(raw, slug);
    if (!frontmatter.publish) continue;
    assertArabicFrontmatter(frontmatter, slug);

    const {
      title,
      description,
      keywords,
      titleAr,
      descriptionAr,
      keywordsAr,
      roles,
      action,
      order,
    } = frontmatter;
    articles.push({
      slug,
      category,
      title,
      description,
      keywords,
      titleAr,
      descriptionAr,
      keywordsAr,
      roles,
      action,
      order,
      body,
    });
  }

  const categoryRank = (category: CategorySlug) => CATEGORY_ORDER.indexOf(category);
  return articles.sort(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) ||
      a.order - b.order ||
      a.slug.localeCompare(b.slug),
  );
}

/**
 * The body as the article page renders it: without a leading `# Title` heading, which the page
 * already shows (with the description) above the content. Articles keep their `#` line so the
 * Markdown still reads as a document on its own; only the first heading, and only an H1, is dropped.
 */
export function articleBodyForPage(body: string): string {
  return body.replace(/^\s*# [^\n]*(?:\r?\n|$)/, "");
}

/** Web path for an article, e.g. `/help/onboarding-guide`. */
export function helpPath(slug: string): string {
  return `/help/${slug}`;
}

/**
 * Catalogue filter for the `/help` home page: every article for an empty query, otherwise the
 * matching articles best first (see `searchHelpArticles` for the matching rules).
 */
export function searchArticles(query: string, corpus: readonly HelpArticle[]): HelpArticle[] {
  if (searchTokens(query).length === 0) return [...corpus];
  return searchHelpArticles(query, corpus).map((hit) => hit.article);
}

export interface HelpSearchOptions {
  /** The caller's roles. Articles whose `roles` intersect them rank higher; nothing is hidden. */
  roles?: readonly string[];
}

/** Field weights: a term in the title (either language) outweighs one in the description or
 * keywords, which outweigh a term that only appears in the body. */
const WEIGHT = { title: 5, description: 3, keywords: 3, heading: 2, body: 1 } as const;
/** A prefix match on the last query token ("stud" → "students") scores a little below an exact one. */
const PREFIX_STRENGTH = 0.75;
/** Multiplier for an article written for one of the caller's roles. Strong enough that, for a
 * comparable match, a FINANCE user sees finance articles first, without letting a passing body
 * mention outrank a title hit. */
const ROLE_BOOST = 2;

/**
 * Ranked help search for the global search palette.
 *
 * - Query and text are compared as `searchTokens` (shared with the destinations registry and the
 *   API), so case, Arabic diacritics and hamza/alef forms do not matter: "أحمد" finds "احمد".
 * - Every query token must match somewhere in the article: title, description or keywords in either
 *   language, or the body. Tokens match whole words; the last token also matches as a prefix, so
 *   results appear while the user is still typing.
 * - An Arabic definite article or a joined "و/ب/ف/ك/ل" + "ال" is ignored on both sides, so
 *   "طالب" finds "الطالب".
 * - `heading` is the `##`/`###` section with the best body match, so the palette can deep-link to
 *   `/help/<slug>#<heading.slug>`; `null` when the body did not match or matched only above the
 *   first heading.
 * - `roles` only boosts (see `ROLE_BOOST`). Help is public: no article is ever filtered out.
 *
 * An empty query returns no hits. Pure; per-article indexes are cached by object identity.
 */
export function searchHelpArticles(
  query: string,
  corpus: readonly HelpArticle[],
  options: HelpSearchOptions = {},
): HelpSearchHit[] {
  const queryTokens = searchTokens(query);
  if (queryTokens.length === 0) return [];
  const terms = queryTokens.map((token, index) => ({
    variants: tokenVariants(token),
    prefix: index === queryTokens.length - 1,
  }));
  const callerRoles = new Set(options.roles ?? []);

  const hits: (HelpSearchHit & { rank: number; roleMatch: boolean })[] = [];
  corpus.forEach((article, rank) => {
    const index = indexFor(article);
    let score = 0;

    for (const term of terms) {
      const title = strength(term, index.title);
      const description = strength(term, index.description);
      const keywords = strength(term, index.keywords);
      let body = 0;
      let heading = 0;
      for (const section of index.sections) {
        const inHeading = strength(term, section.heading);
        heading = Math.max(heading, inHeading);
        body = Math.max(body, inHeading, strength(term, section.text));
      }
      if (title + description + keywords + body === 0) return; // every term must match
      score +=
        title * WEIGHT.title +
        description * WEIGHT.description +
        keywords * WEIGHT.keywords +
        heading * WEIGHT.heading +
        body * WEIGHT.body;
    }

    const roleMatch = article.roles.some((role) => callerRoles.has(role));
    if (roleMatch) score *= ROLE_BOOST;

    hits.push({ article, score, heading: bestHeading(index, terms), rank, roleMatch });
  });

  return hits
    .sort(
      (a, b) => b.score - a.score || Number(b.roleMatch) - Number(a.roleMatch) || a.rank - b.rank,
    )
    .map(({ article, score, heading }) => ({ article, score, heading }));
}

interface Term {
  variants: readonly string[];
  prefix: boolean;
}

/** The `##`/`###` heading of the section that matches the most (a heading hit counts double); the
 * first such section wins a tie. `null` when the best match is above the first heading or the
 * body does not match at all. */
function bestHeading(index: ArticleIndex, terms: readonly Term[]): HelpSearchHit["heading"] {
  let best: { anchor: HelpSearchHit["heading"]; score: number } | null = null;
  for (const section of index.sections) {
    const score = terms.reduce(
      (sum, term) =>
        sum +
        strength(term, section.heading) * WEIGHT.heading +
        strength(term, section.text) * WEIGHT.body,
      0,
    );
    if (score > 0 && (!best || score > best.score)) best = { anchor: section.anchor, score };
  }
  return best?.anchor ?? null;
}

/** Normalized token variants of one field: the tokens plus their article-stripped forms. */
interface TokenField {
  exact: ReadonlySet<string>;
  all: readonly string[];
}

interface ArticleIndex {
  title: TokenField;
  description: TokenField;
  keywords: TokenField;
  sections: readonly {
    anchor: { text: string; slug: string } | null;
    heading: TokenField;
    text: TokenField;
  }[];
}

const INDEX_CACHE = new WeakMap<HelpArticle, ArticleIndex>();

function indexFor(article: HelpArticle): ArticleIndex {
  const cached = INDEX_CACHE.get(article);
  if (cached) return cached;
  const index: ArticleIndex = {
    title: tokenField(`${article.title} ${article.titleAr}`),
    description: tokenField(`${article.description} ${article.descriptionAr}`),
    keywords: tokenField([...article.keywords, ...article.keywordsAr].join(" ")),
    sections: splitSections(article.body).map((section) => ({
      anchor: section.heading ? { text: section.heading, slug: slugify(section.heading) } : null,
      heading: tokenField(section.heading ?? ""),
      text: tokenField(section.text),
    })),
  };
  INDEX_CACHE.set(article, index);
  return index;
}

function tokenField(text: string): TokenField {
  const all = [...new Set(searchTokens(text).flatMap(tokenVariants))];
  return { exact: new Set(all), all };
}

/** Joined Arabic prefixes dropped for matching, longest first: "والطلاب" → "طلاب". */
const ARABIC_ARTICLE_PREFIXES = ["وال", "بال", "فال", "كال", "ال", "لل"];

function tokenVariants(token: string): string[] {
  const prefix = ARABIC_ARTICLE_PREFIXES.find(
    (candidate) => token.startsWith(candidate) && token.length - candidate.length >= 2,
  );
  return prefix ? [token, token.slice(prefix.length)] : [token];
}

/** 1 for a whole-word match, `PREFIX_STRENGTH` for a prefix match on the last term, else 0. */
function strength(term: Term, field: TokenField): number {
  if (term.variants.some((variant) => field.exact.has(variant))) return 1;
  if (
    term.prefix &&
    term.variants.some((variant) => field.all.some((token) => token.startsWith(variant)))
  ) {
    return PREFIX_STRENGTH;
  }
  return 0;
}

const SECTION_HEADING_RE = /^(#{2,3})\s+(.+?)\s*#*\s*$/;

/** Splits a Markdown body at its `##`/`###` headings (outside fenced code). The first section holds
 * whatever precedes the first such heading and has no heading. */
function splitSections(body: string): { heading: string | null; text: string }[] {
  let current: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  const sections = [current];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : SECTION_HEADING_RE.exec(line);
    if (heading) {
      current = { heading: plainHeading(heading[2]), lines: [] };
      sections.push(current);
    } else {
      current.lines.push(line);
    }
  }
  return sections.map(({ heading, lines }) => ({ heading, text: lines.join("\n") }));
}

/** Heading text as rendered (inline Markdown markers removed), so `slugify` matches the id the
 * renderer gives the heading. */
function plainHeading(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
}
