import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";

import {
  articleBodyForPage,
  categoryLabel,
  CATEGORY_ORDER,
  helpPath,
  searchArticles,
  searchHelpArticles,
} from "./content";

import type { HelpSearchOptions } from "./content";
import type { HelpArticle, HelpSearchHit } from "./content.types";
import type { SessionTokens } from "../../lib/auth";
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
    titleAr: "دليل الإعداد",
    descriptionAr: "أكمل معالج الإعداد خطوة بخطوة.",
    keywordsAr: ["إعداد", "معالج"],
    roles: [],
    action: null,
    order: 1,
    body: "# Onboarding guide\n\n## Step 1: School profile\n\nDescribe the school first.",
  },
  {
    slug: "invitations",
    category: "getting-started",
    title: "Invitations",
    description: "Invite staff, students and parents.",
    keywords: ["invitation"],
    titleAr: "الدعوات",
    descriptionAr: "ادعُ الموظفين والطلاب وأولياء الأمور.",
    keywordsAr: ["دعوة"],
    roles: [],
    action: "invite-staff",
    order: 2,
    body: "Invitations are how anyone joins the school.",
  },
  {
    slug: "timetable",
    category: "academics",
    title: "Timetables",
    description: "Build a working timetable.",
    keywords: ["timetable"],
    titleAr: "الجدول الدراسي",
    descriptionAr: "أنشئ جدولًا دراسيًا.",
    keywordsAr: ["جدول"],
    roles: [],
    action: null,
    order: 1,
    body: "A timetable needs periods and subjects.",
  },
];

function searchHelp(query: string, options?: HelpSearchOptions): HelpSearchHit[] {
  return searchHelpArticles(query, FIXTURE_ARTICLES, options);
}

function filterHelpCatalog(query: string): HelpArticle[] {
  return searchArticles(query, FIXTURE_ARTICLES);
}

function findArticleBySlug(slug: string): HelpArticle | undefined {
  return FIXTURE_ARTICLES.find((article) => article.slug === slug);
}

mock.module("./articles", () => ({
  articles: FIXTURE_ARTICLES,
  articleBySlug: findArticleBySlug,
  searchHelp,
  filterHelpCatalog,
  articleBodyForPage,
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

/** Signed out: a store that never restored a session, as for a public visitor to /help. */
function renderInMain(Page: ComponentType, path: string) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => {
        throw new Error("signed out");
      },
      logout: async () => undefined,
    },
  });
  return render(
    <AuthProvider store={store}>
      <main>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={<Page />} />
            <Route path="/help/:slug" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </main>
    </AuthProvider>,
  );
}

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderSignedIn(Page: ComponentType, path: string, roles: readonly string[]) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();
  return render(
    <AuthProvider store={store}>
      <main>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/help/:slug" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </main>
    </AuthProvider>,
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

  test("home search also matches Arabic frontmatter", async () => {
    renderInMain(await loadHomePage(), "/");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search the help center" }), {
      target: { value: "الجدول" },
    });

    expect(screen.getByRole("link", { name: /Timetables/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Invitations/ })).toBeNull();
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

  test("Do it now opens the article's task for a reader who can do it", async () => {
    await renderSignedIn(await loadArticlePage(), "/help/invitations", ["ORG_ADMIN"]);

    expect(screen.getByRole("link", { name: "Do it now" }).getAttribute("href")).toBe(
      "/portal/accounts?invite=1",
    );
  });

  test("Do it now is hidden from a reader who cannot open the task, or is signed out", async () => {
    await renderSignedIn(await loadArticlePage(), "/help/invitations", ["FINANCE"]);
    expect(screen.queryByRole("link", { name: "Do it now" })).toBeNull();
    cleanup();

    renderInMain(await loadArticlePage(), "/help/invitations");
    expect(screen.queryByRole("link", { name: "Do it now" })).toBeNull();
  });

  test("article page shows the title once, not again from the article's own # heading", async () => {
    renderInMain(await loadArticlePage(), "/help/onboarding-guide");

    expect(screen.getAllByRole("heading", { name: "Onboarding guide" })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
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
