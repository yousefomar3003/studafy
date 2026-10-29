import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";

import { SEARCH_TYPES } from "./queries";

import type { SessionTokens } from "../../lib/auth";
import type { ComponentType } from "react";

function student(index: number) {
  return {
    id: `s-${index}`,
    first_name: "Omar",
    last_name: `Student ${index}`,
    preferred_name: null,
    admission_number: `A-${index}`,
    status: "enrolled",
    rank: 1,
  };
}

const invoice = {
  id: "i-1",
  erpnext_docname: "INV-0012",
  erpnext_status: "Unpaid",
  total_amount: "100.00",
  total_amount_minor: 10000,
  currency: "AED",
  student_id: "s-1",
  student_name: "Omar Student 1",
  rank: 1,
};

interface SearchCall {
  q: string;
  types?: string[];
  limit?: number;
  offset?: number;
}

const getMock = mock((path: string, init?: { params?: { query?: SearchCall } }) => {
  if (path !== "/api/search") return Promise.resolve({ data: undefined });
  const query = init!.params!.query!;
  const only = query.types?.[0];
  const offset = query.offset ?? 0;
  const students =
    only === "students"
      ? Array.from({ length: 20 }, (_, index) => student(offset + index + 1))
      : only
        ? []
        : [student(1), student(2)];
  const invoices = only === undefined || only === "invoices" ? [invoice] : [];
  const totals = Object.fromEntries(SEARCH_TYPES.map((type) => [type, 0]));
  totals.students = 45;
  totals.invoices = 1;
  return Promise.resolve({
    data: {
      query: query.q,
      types: only ? [only] : [...SEARCH_TYPES],
      results: {
        ...Object.fromEntries(SEARCH_TYPES.map((type) => [type, []])),
        students,
        invoices,
      },
      totals,
    },
  });
});

mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./SearchResultsPage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAt(entry: string, roles: readonly string[] = ["PRINCIPAL"]) {
  const Page = await loadPage();
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
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/portal/search" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("SearchResultsPage", () => {
  test("shows every type with matches as a filter chip, with its count", async () => {
    await renderAt("/portal/search?q=omar");
    const filters = within(await screen.findByRole("navigation", { name: "Filter by type" }));
    expect(filters.getByRole("link", { name: "All types" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(filters.getByRole("link", { name: /Students 45/ }).getAttribute("href")).toBe(
      "/portal/search?q=omar&type=students",
    );
    expect(filters.getByRole("link", { name: /Invoices 1/ })).toBeTruthy();
  });

  test("groups link role-aware (a principal's student page) and offer See all", async () => {
    await renderAt("/portal/search?q=omar");
    const studentLink = await screen.findByRole("link", { name: "Omar Student 1" });
    expect(studentLink.getAttribute("href")).toBe("/portal/principal/students/s-1");
    expect(screen.getByRole("link", { name: "See all 45 results" }).getAttribute("href")).toBe(
      "/portal/search?q=omar&type=students",
    );
  });

  test("a type filter pages through that one type", async () => {
    await renderAt("/portal/search?q=omar&type=students&page=2");
    await screen.findByRole("link", { name: "Omar Student 21" });
    expect(getMock).toHaveBeenCalledWith("/api/search", {
      params: { query: { q: "omar", types: ["students"], limit: 20, offset: 20 } },
    });
    const pager = within(screen.getByRole("navigation", { name: "Results pages" }));
    expect(pager.getByText("Page 2 of 3")).toBeTruthy();
    expect(pager.getByRole("link", { name: "Previous" }).getAttribute("href")).toBe(
      "/portal/search?q=omar&type=students",
    );
    expect(pager.getByRole("link", { name: "Next" }).getAttribute("href")).toBe(
      "/portal/search?q=omar&type=students&page=3",
    );
  });

  test("a query that is too short never calls the API", async () => {
    await renderAt("/portal/search?q=o");
    expect(await screen.findByText("Enter at least 2 characters to search.")).toBeTruthy();
    await waitFor(() => expect(getMock).not.toHaveBeenCalled());
  });
});
