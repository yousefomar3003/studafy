/** Category slugs correspond one-to-one with the public directories under `/docs/help`. */
export type CategorySlug = "getting-started" | "academics" | "finance" | "billing";

export interface HelpArticle {
  /** Canonical URL segment: `getting-started/onboarding-guide.md` → `onboarding-guide`. */
  slug: string;
  category: CategorySlug;
  title: string;
  description: string;
  keywords: string[];
  /** Ascending sort within a category; seen by the catalog. */
  order: number;
  /** Markdown body, frontmatter removed. */
  body: string;
}
