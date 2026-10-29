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
import academicSetup from "@docs/help/academics/academic-setup.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import buildTimetable from "@docs/help/academics/build-timetable.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import takeAttendance from "@docs/help/academics/take-attendance.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import timetable from "@docs/help/academics/timetable.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import subscriptions from "@docs/help/billing/subscriptions.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import createInvoiceBatch from "@docs/help/finance/create-invoice-batch.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import issueRefund from "@docs/help/finance/issue-refund.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import recordPayment from "@docs/help/finance/record-payment.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import workflows from "@docs/help/finance/workflows.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import addStudent from "@docs/help/getting-started/add-student.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import importStudents from "@docs/help/getting-started/import-students.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import inviteStaff from "@docs/help/getting-started/invite-staff.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import linkParent from "@docs/help/getting-started/link-parent.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import onboardingGuide from "@docs/help/getting-started/onboarding-guide.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import studentAndParentRecords from "@docs/help/getting-started/student-and-parent-records.md?raw";

import { buildArticles, searchArticles, searchHelpArticles } from "./content";

import type { HelpSearchOptions } from "./content";
import type { HelpArticle, HelpSearchHit } from "./content.types";

const ARTICLE_SOURCES = [
  { path: "@docs/help/academics/academic-setup.md", raw: academicSetup },
  { path: "@docs/help/academics/build-timetable.md", raw: buildTimetable },
  { path: "@docs/help/academics/take-attendance.md", raw: takeAttendance },
  { path: "@docs/help/academics/timetable.md", raw: timetable },
  { path: "@docs/help/billing/subscriptions.md", raw: subscriptions },
  { path: "@docs/help/finance/create-invoice-batch.md", raw: createInvoiceBatch },
  { path: "@docs/help/finance/issue-refund.md", raw: issueRefund },
  { path: "@docs/help/finance/record-payment.md", raw: recordPayment },
  { path: "@docs/help/finance/workflows.md", raw: workflows },
  { path: "@docs/help/getting-started/add-student.md", raw: addStudent },
  { path: "@docs/help/getting-started/import-students.md", raw: importStudents },
  { path: "@docs/help/getting-started/invite-staff.md", raw: inviteStaff },
  { path: "@docs/help/getting-started/link-parent.md", raw: linkParent },
  { path: "@docs/help/getting-started/onboarding-guide.md", raw: onboardingGuide },
  {
    path: "@docs/help/getting-started/student-and-parent-records.md",
    raw: studentAndParentRecords,
  },
] as const;

/** Published articles, sorted by category then `order` (see `buildArticles`). */
export const articles: readonly HelpArticle[] = buildArticles(ARTICLE_SOURCES);

export function articleBySlug(slug: string): HelpArticle | undefined {
  return articles.find((article) => article.slug === slug);
}

/**
 * Ranked help search for the global search palette, bound to the published catalogue: English and
 * Arabic, prefix match on the last word, best heading for deep links, role boost (never a filter).
 * See `searchHelpArticles`.
 */
export function searchHelp(query: string, options: HelpSearchOptions = {}): HelpSearchHit[] {
  return searchHelpArticles(query, articles, options);
}

/** The `/help` home page filter: every article for an empty query, else matches best first. */
export function filterHelpCatalog(query: string): HelpArticle[] {
  return searchArticles(query, articles);
}

// Home and article pages only need these from `content.ts`; re-exporting keeps their imports to a
// single module, so replacements stay simple under `bun test` (see `help.test.tsx`).
export { articleBodyForPage, CATEGORY_ORDER, categoryLabel, helpPath } from "./content";
export type { HelpSearchOptions } from "./content";
export type { HelpArticle, HelpSearchHit } from "./content.types";
