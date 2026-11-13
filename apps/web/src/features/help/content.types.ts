import type { Role } from "@studafy/constants";

/** Category slugs correspond one-to-one with the public directories under `/docs/help`. */
export type CategorySlug = "getting-started" | "academics" | "finance" | "billing";

export interface HelpArticle {
  /** Canonical URL segment: `getting-started/onboarding-guide.md` → `onboarding-guide`. */
  slug: string;
  category: CategorySlug;
  title: string;
  description: string;
  keywords: string[];
  /** Arabic title, description and keywords (frontmatter `title_ar`, `description_ar`,
   * `keywords_ar`). Required on every published article; only searched, not rendered yet. */
  titleAr: string;
  descriptionAr: string;
  keywordsAr: string[];
  /** Roles the article is mainly for (frontmatter `roles`). Only boosts search ranking for callers
   * holding one of them; help is public, so it never hides an article. Empty when unset. */
  roles: Role[];
  /** Search-registry action id this article walks through (frontmatter `action`), e.g.
   * `add-student`; `null` when unset. Shape-checked only (`^[a-z0-9-]+$`). */
  action: string | null;
  /** Ascending sort within a category; seen by the catalog. */
  order: number;
  /** Markdown body, frontmatter removed. */
  body: string;
}

/** A ranked help-search hit for the global search palette. */
export interface HelpSearchHit {
  article: HelpArticle;
  score: number;
  /** The `##`/`###` heading the best body match sits under, if any. Link to
   * `/help/<slug>#<heading.slug>`. */
  heading: { text: string; slug: string } | null;
}
