import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../lib/test/axe";

import { categoryLabel, CATEGORY_ORDER, helpPath, searchArticles } from "./content";

import type { HelpArticle } from "./content.types";
import type { ComponentType } from "react";

/**
 * Behavior + accessibility audits for the two `/help` pages. The pages read everything from the
 * `./articles` module, which under `bun test` cannot load — its `@docs/...md?raw` imports are a
 * Vite-only alias (see `vite.config.ts`) — so the module is swapped for a fixture catalogue built
 * from the real pure helpers in `./content`. The actual `/docs/help` files are exercised against
 * `buildArticles` in `content.test.ts` instead.
 */

const FIXTURE_ARTICLES: readonly HelpArticle[] = [
  {
    slug: "onboarding-guide",
    category: "getting-started",
    title: "Onboarding guide",
    description: "Complete the setup wizard step by step.",
    keywords: ["onboarding", "setup"],
    order: 1,
    body: "## Step 1: School profile\n\nDescribe the school first.",
  },
  {
    slug: "invitations",
    category: "getting-started",
    title: "Invitations",
    description: "Invite staff, students and parents.",
    keywords: ["invitation"],
    order: 2,
    body: "Invitations are how anyone joins the school.",
  },
  {
    slug: "timetable",
    category: "academics",
    title: "Timetables",
    description: "Build a working timetable.",
    keywords: ["timetable"],
    order: 1,
    body: "A timetable needs periods and subjects.",
  },
];

function searchHelp(query: string): HelpArticle[] {
  return searchArticles(query, FIXTURE_ARTICLES);
}

function findArticleBySlug(slug: string): HelpArticle | undefined {
  return FIXTURE_ARTICLES.find((article) => article.slug === slug);
}

mock.module("./articles", () => ({
  articles: FIXTURE_ARTICLES,
  articleBySlug: findArticleBySlug,
  searchHelp,
  CATEGORY_ORDER,
  categoryLabel,
  helpPath,
}));

async function loadHomePage(): Promise<ComponentType> {
  return (await import("./HelpHomePage")).default;
}

async function loadArticlePage(): Promise<ComponentType> {
  return (await import("./HelpArticlePage")).default;
}

function renderInMain(Page: ComponentType, path: string) {
  return render(
    <main>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<Page />} />
          <Route path="/help/:slug" element={<Page />} />
        </Routes>
      </MemoryRouter>
    </main>,
  );
}

afterEach(() => {
  cleanup();
});

describe("help center pages", () => {
  test("home catalog lists every published article grouped by category", async () => {
    renderInMain(await loadHomePage(), "/");

    expect(screen.getByRole("heading", { name: "Help center" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Getting started" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Academics" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Onboarding guide/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Timetables/ })).toBeTruthy();
  });

  test("home search filters the catalogue to matching articles", async () => {
    renderInMain(await loadHomePage(), "/");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search the help center" }), {
      target: { value: "invitation" },
    });

    expect(screen.getByRole("link", { name: /Invitations/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Timetables/ })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search the help center" }), {
      target: { value: "timetable" },
    });
    expect(screen.queryByRole("link", { name: /Invitations/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Timetables/ })).toBeTruthy();
  });

  test("home shows the empty state for a query with no matches", async () => {
    renderInMain(await loadHomePage(), "/");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search the help center" }), {
      target: { value: "zzz-nonexistent" },
    });

    expect(screen.getByText("No articles match your search.")).toBeTruthy();
  });

  test("article page renders content with canonical heading anchors", async () => {
    renderInMain(await loadArticlePage(), "/help/onboarding-guide");

    expect(screen.getByRole("heading", { name: "Onboarding guide" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Step 1: School profile" }).getAttribute("id")).toBe(
      "step-1-school-profile",
    );
    expect(screen.getByText("Describe the school first.")).toBeTruthy();
  });

  test("article page shows a not-found state for an unknown slug", async () => {
    renderInMain(await loadArticlePage(), "/help/nope");

    expect(screen.getByRole("heading", { name: "Article not found" })).toBeTruthy();
  });

  test("home has no accessibility violations", async () => {
    const { container } = renderInMain(await loadHomePage(), "/");
    await expectNoA11yViolations(container);
  });

  test("article page has no accessibility violations", async () => {
    const { container } = renderInMain(await loadArticlePage(), "/help/onboarding-guide");
    await expectNoA11yViolations(container);
  });
});
