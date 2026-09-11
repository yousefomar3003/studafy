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
import type { CategorySlug, HelpArticle } from "./content.types";

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
 * onboarding wizard's step links. "Step 5: Staff invitations" → `step-5-staff-invitations`.
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
  order: number;
  publish: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const KEYWORDS_RE = /^keywords:\s*\[(.*)\]$/;
const KEYWORDS_BLOCK_RE = /keywords:\s*\[([\s\S]*?)\]/;
const STRING_KEY_RE = /^([A-Za-z]+):\s*(.+)$/;
const NUMBER_KEY_RE = /^([A-Za-z]+):\s*(\d+)$/;

function parseFrontmatter(raw: string, slug: string): { frontmatter: Frontmatter; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error(`help article "${slug}" is missing its frontmatter block`);
  }

  const frontmatter: Frontmatter = {
    title: slug,
    description: "",
    keywords: [],
    order: 0,
    publish: true,
  };
  // Prettier wraps long keyword arrays across lines; flatten any such array so the line-oriented
  // parser below only ever sees the canonical single-line `keywords: [...]` form.
  const flattenedFrontmatter = match[1].replace(
    KEYWORDS_BLOCK_RE,
    (_, values: string) => `keywords: [${values.replace(/\s+/g, " ").trim()}]`,
  );
  for (const line of flattenedFrontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const keywords = KEYWORDS_RE.exec(trimmed);
    if (keywords) {
      frontmatter.keywords = keywords[1]
        .split(",")
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0);
      continue;
    }

    const number = NUMBER_KEY_RE.exec(trimmed);
    if (number) {
      const value = Number(number[2]);
      if (number[1] === "order") frontmatter.order = value;
      if (number[1] === "publish") frontmatter.publish = value === 1;
      continue;
    }

    const string = STRING_KEY_RE.exec(trimmed);
    if (string) {
      if (string[1] === "title") frontmatter.title = string[2].replace(/^"|"$/g, "");
      else if (string[1] === "description")
        frontmatter.description = string[2].replace(/^"|"$/g, "");
      else if (string[1] === "publish") {
        if (string[2] !== "true" && string[2] !== "false") {
          throw new Error(`help article "${slug}" has an invalid publish value: "${string[2]}"`);
        }
        frontmatter.publish = string[2] === "true";
      } else {
        throw new Error(`help article "${slug}" has an unsupported frontmatter line: "${trimmed}"`);
      }
      continue;
    }

    throw new Error(`help article "${slug}" has an unsupported frontmatter line: "${trimmed}"`);
  }

  return { frontmatter, body: raw.slice(match[0].length) };
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

    const { title, description, keywords, order } = frontmatter;
    articles.push({ slug, category, title, description, keywords, order, body });
  }

  const categoryRank = (category: CategorySlug) => CATEGORY_ORDER.indexOf(category);
  return articles.sort(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) ||
      a.order - b.order ||
      a.slug.localeCompare(b.slug),
  );
}

/** Web path for an article, e.g. `/help/onboarding-guide`. */
export function helpPath(slug: string): string {
  return `/help/${slug}`;
}

/**
 * Naive weighted term search over a corpus. Good enough for a catalogue of a few dozen pieces of
 * content — no external index, no network call. Terms must match at least one of the weighted
 * fields; the more fields a term hits, the higher the article ranks.
 */
export function searchArticles(query: string, corpus: readonly HelpArticle[]): HelpArticle[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...corpus];

  const hit = (haystack: readonly string[] | string, term: string) =>
    (Array.isArray(haystack) ? haystack : [haystack]).join(" ").toLowerCase().includes(term);

  const scoreArticle = (article: HelpArticle) =>
    terms.reduce((score, term) => {
      if (hit(article.title, term)) score += 5;
      if (hit(article.description, term)) score += 3;
      if (hit(article.keywords, term)) score += 3;
      if (hit(article.body, term)) score += 1;
      return score;
    }, 0);

  return corpus
    .map((article) => ({ article, score: scoreArticle(article) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.article);
}
