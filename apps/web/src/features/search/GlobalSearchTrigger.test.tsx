import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";
import {
  articleBodyForPage,
  buildArticles,
  categoryLabel,
  CATEGORY_ORDER,
  helpPath,
  searchArticles,
  searchHelpArticles,
} from "../help/content";

import type { SessionTokens } from "../../lib/auth";
import type { HelpSearchOptions } from "../help/content";
import type { ComponentType } from "react";

const SEARCH_TYPES = [
  "students",
  "users",
  "invoices",
  "materials",
  "classes",
  "sections",
  "subjects",
  "grade_levels",
  "academic_years",
  "terms",
  "rooms",
  "families",
  "announcements",
  "events",
  "incidents",
  "evaluations",
  "fee_structures",
  "scholarships",
  "expenses",
  "notifications",
] as const;

const STUDENT_HIT = {
  id: "s-1",
  first_name: "Ahmad",
  last_name: "Ali",
  preferred_name: null,
  admission_number: "A-100",
  status: "enrolled",
  rank: 0.9,
};

const MATERIAL_HIT = {
  id: "m-1",
  class_id: "c-1",
  title: "Algebra unit 4",
  description: null,
  ingest_status: "ready",
  rank: 0.4,
};

function response(
  q: string,
  hits: Record<string, unknown[]> = {},
  totals: Record<string, number> = {},
) {
  return {
    data: {
      query: q,
      types: [...SEARCH_TYPES],
      results: Object.fromEntries(SEARCH_TYPES.map((type) => [type, hits[type] ?? []])),
      totals: Object.fromEntries(
        SEARCH_TYPES.map((type) => [type, totals[type] ?? hits[type]?.length ?? 0]),
      ),
    },
  };
}

const getMock = mock((path: string, init?: { params?: { query?: { q?: string } } }) => {
  if (path !== "/api/search") return Promise.resolve({ data: undefined });
  const q = init?.params?.query?.q ?? "";
  if (q === "ahmad") {
    return Promise.resolve(
      response(q, { students: [STUDENT_HIT], materials: [MATERIAL_HIT] }, { students: 12 }),
    );
  }
  return Promise.resolve(response(q));
});

mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

// The real catalogue imports Markdown through Vite's `?raw`, which `bun test` cannot load; one
// fixture article stands in for it. The mock exposes the module's whole surface, since bun shares
// module mocks across test files (help.test.tsx imports the rest).
const FIXTURE_ARTICLES = buildArticles([
  {
    path: "@docs/help/getting-started/import-students.md",
    raw: `---
title: "Import students from a CSV file"
description: "Upload a CSV of students."
keywords: ["csv", "upload"]
title_ar: "استيراد الطلاب من ملف CSV"
description_ar: "ارفع ملف CSV للطلاب."
keywords_ar: ["استيراد", "ملف"]
action: import-students
order: 1
---

## Check the preview

Every row is checked for import mistakes before anything is saved.
`,
  },
]);

mock.module("../help/articles", () => ({
  articles: FIXTURE_ARTICLES,
  articleBySlug: (slug: string) => FIXTURE_ARTICLES.find((article) => article.slug === slug),
  searchHelp: (query: string, options?: HelpSearchOptions) =>
    searchHelpArticles(query, FIXTURE_ARTICLES, options),
  filterHelpCatalog: (query: string) => searchArticles(query, FIXTURE_ARTICLES),
  articleBodyForPage,
  CATEGORY_ORDER,
  categoryLabel,
  helpPath,
}));

const loadTrigger = async (): Promise<ComponentType> =>
  (await import("./GlobalSearchTrigger")).GlobalSearchTrigger;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>
  );
}

async function renderTrigger(Trigger: ComponentType, roles: readonly string[] = ["ORG_ADMIN"]) {
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

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The trigger normally lives in `PortalHeader`, which stays mounted across a navigation
  // (`PortalLayout` renders it alongside an `<Outlet />`) -- nesting it the same way here so
  // "select a result" tests can assert on both the navigation and the still-mounted trigger.
  function PortalLayout() {
    return (
      <>
        <Trigger />
        <Outlet />
        <LocationProbe />
      </>
    );
  }
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/portal"]}>
          <Routes>
            <Route path="/portal" element={<PortalLayout />}>
              <Route index element={<p>Portal home</p>} />
              <Route path="*" element={<p>Somewhere else</p>} />
            </Route>
            <Route path="/help/*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

async function openPalette(roles?: readonly string[]) {
  await renderTrigger(await loadTrigger(), roles);
  fireEvent.click(screen.getByRole("button", { name: /search/i }));
  return screen.findByRole("combobox");
}

function location(): string {
  return screen.getByTestId("location").textContent ?? "";
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  getMock.mockClear();
  window.localStorage.clear();
});

describe("GlobalSearchTrigger", () => {
  test("opens the palette on click", async () => {
    await renderTrigger(await loadTrigger());
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("opens the palette on Ctrl+K from anywhere, and a second Ctrl+K closes it", async () => {
    await renderTrigger(await loadTrigger());
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("the empty state suggests the role's tasks", async () => {
    await openPalette(["ORG_ADMIN"]);
    expect(await screen.findByText("Suggested for you")).toBeTruthy();
    expect(screen.getByText("Add a student")).toBeTruthy();
  });

  test("a finance user is suggested finance tasks, not the admin's", async () => {
    await openPalette(["FINANCE"]);
    await screen.findByText("Suggested for you");
    expect(screen.queryByText("Add a student")).toBeNull();
    expect(screen.getByText("Record a payment")).toBeTruthy();
  });

  test("pages and actions show at once, before the record search answers", async () => {
    const input = await openPalette();
    await screen.findByText("Suggested for you");
    fireEvent.change(input, { target: { value: "guardian" } });
    // Synchronous: no waiting for the 300 ms debounce or the API.
    expect(screen.getByText("Go to")).toBeTruthy();
    expect(screen.getByText("Link a parent to a student")).toBeTruthy();
    expect(getMock).not.toHaveBeenCalled();
  });

  test("an action opens its page with the create modal's URL state", async () => {
    const input = await openPalette();
    await screen.findByText("Suggested for you");
    fireEvent.change(input, { target: { value: "add a student" } });
    await screen.findByText("Do");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(location()).toBe("/portal/admin/students?create=1"));
  });

  test("help hits link to the article's heading", async () => {
    const input = await openPalette();
    await screen.findByText("Suggested for you");
    fireEvent.change(input, { target: { value: "import" } });
    fireEvent.click(await screen.findByText("Import students from a CSV file"));
    await waitFor(() => expect(location()).toBe("/help/import-students#check-the-preview"));
  });

  test("records follow the instant groups, and Enter on a student opens their profile", async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "ahmad" } });
    await screen.findByText("Ahmad Ali");
    expect(screen.getByText("Students")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(location()).toBe("/portal/admin/students/s-1"));
  });

  test("arrow keys move through the groups in order, and Enter opens See all", async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "ahmad" } });
    await screen.findByText("Ahmad Ali");

    const options = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(options[1]!.textContent).toContain("See all 12 results");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // The material row is read-only, so the selection wraps past it to the first row.
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);

    fireEvent.keyDown(input, { key: "End" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(location()).toBe("/portal/search?q=ahmad&type=students"));
  });

  test("a material hit (no portal page yet) is shown but not selectable", async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "ahmad" } });
    const materialRow = await screen.findByText("Algebra unit 4");
    expect(materialRow.closest('[role="option"]')).toBeNull();
    expect(materialRow.closest('[role="presentation"]')).toBeTruthy();
  });

  test("no results suggests the help center and the closest pages", async () => {
    const input = await openPalette();
    await screen.findByText("Suggested for you");
    fireEvent.change(input, { target: { value: "timtable" } });
    await screen.findByText("No results for “timtable”.");
    expect(screen.getByText("Closest matches")).toBeTruthy();
    expect(screen.getByText("Browse the help center")).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(1);
  });

  test("in:<type> asks the API for that one type", async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "in:invoices inv-00" } });
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith("/api/search", {
        params: { query: { q: "inv-00", types: ["invoices"] } },
      }),
    );
  });

  test("selecting a result records it as a recent search, and clicking it re-runs it", async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "ahmad" } });
    await screen.findByText("Ahmad Ali");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(location()).toBe("/portal/admin/students/s-1"));

    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("Recent searches");
    fireEvent.click(screen.getByText("ahmad"));
    await screen.findByText("Ahmad Ali");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("has no accessibility violations with grouped results shown", async () => {
    const { container } = await renderTrigger(await loadTrigger());
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "ahmad" } });
    await screen.findByText("Ahmad Ali");
    await expectNoA11yViolations(container);
  });
});
