/**
 * The published article catalogue — the only module that pulls in the raw Markdown.
 *
 * The files live in `/docs/help` at the repository root, outside Vite's project root, so they are
 * imported through the `@docs` alias with Vite's `?raw` suffix and wired up here next to the alias
 * (see `vite.config.ts`). Keeping those imports in this one module means `content.ts` — the pure
 * parser and search — never depends on Vite and stays unit-testable under `bun test` (see
 * `content.test.ts`). Adding an article is exactly one new line here plus the file itself.
 */
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import timetable from "@docs/help/academics/timetable.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import subscriptions from "@docs/help/billing/subscriptions.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import workflows from "@docs/help/finance/workflows.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import invitations from "@docs/help/getting-started/invitations.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import onboardingGuide from "@docs/help/getting-started/onboarding-guide.md?raw";

import { buildArticles, searchArticles } from "./content";

import type { HelpArticle } from "./content.types";

const ARTICLE_SOURCES = [
  { path: "@docs/help/academics/timetable.md", raw: timetable },
  { path: "@docs/help/billing/subscriptions.md", raw: subscriptions },
  { path: "@docs/help/finance/workflows.md", raw: workflows },
  { path: "@docs/help/getting-started/invitations.md", raw: invitations },
  { path: "@docs/help/getting-started/onboarding-guide.md", raw: onboardingGuide },
] as const;

/** Published articles, sorted by category then `order` (see `buildArticles`). */
export const articles: readonly HelpArticle[] = buildArticles(ARTICLE_SOURCES);

export function articleBySlug(slug: string): HelpArticle | undefined {
  return articles.find((article) => article.slug === slug);
}

/** Search bound to the published catalogue. */
export function searchHelp(query: string): HelpArticle[] {
  return searchArticles(query, articles);
}

// Home and article pages only need these from `content.ts`; re-exporting keeps their imports to a
// single module, so replacements stay simple under `bun test` (see `help.test.tsx`).
export { CATEGORY_ORDER, categoryLabel, helpPath } from "./content";
