import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../lib/test/axe";

import type { ComponentType } from "react";

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

function emptyResults() {
  return { students: [], users: [], invoices: [], materials: [] };
}

const getMock = mock((path: string, init?: { params?: { query?: { q?: string } } }) => {
  if (path !== "/api/search") return Promise.resolve({ data: undefined });
  const q = init?.params?.query?.q ?? "";
  if (q === "ahmad") {
    return Promise.resolve({
      data: {
        query: q,
        results: { ...emptyResults(), students: [STUDENT_HIT], materials: [MATERIAL_HIT] },
      },
    });
  }
  return Promise.resolve({ data: { query: q, results: emptyResults() } });
});

mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadTrigger = async (): Promise<ComponentType> =>
  (await import("./GlobalSearchTrigger")).GlobalSearchTrigger;

function renderTrigger(Trigger: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The trigger normally lives in `PortalHeader`, which stays mounted across a navigation
  // (`PortalLayout` renders it alongside an `<Outlet />`) -- nesting it the same way here so
  // "select a result" tests can assert on both the navigation and the still-mounted trigger
  // afterward, instead of it disappearing along with a route swap that doesn't happen for real.
  function PortalLayout() {
    return (
      <>
        <Trigger />
        <Outlet />
      </>
    );
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/portal"]}>
        <Routes>
          <Route path="/portal" element={<PortalLayout />}>
            <Route index element={<p>Portal home</p>} />
            <Route path="admin/students/:studentId" element={<p>Student profile</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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
    renderTrigger(await loadTrigger());

    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("opens the palette on Ctrl+K from anywhere, without needing the trigger focused", async () => {
    renderTrigger(await loadTrigger());

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("toggles closed on a second Ctrl+K", async () => {
    renderTrigger(await loadTrigger());

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog");

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("typing a query groups results per type, and Enter on the active row navigates there", async () => {
    renderTrigger(await loadTrigger());
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "ahmad" } });

    await screen.findByText("Ahmad Ali");
    expect(screen.getByText("Algebra unit 4")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });

    await screen.findByText("Student profile");
  });

  test("a material hit (no portal page yet) is shown but not selectable", async () => {
    renderTrigger(await loadTrigger());
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "ahmad" } });
    const materialRow = await screen.findByText("Algebra unit 4");

    expect(materialRow.closest('[role="option"]')).toBeNull();
    expect(materialRow.closest('[role="presentation"]')).toBeTruthy();
  });

  test("no results for a query with no matches", async () => {
    renderTrigger(await loadTrigger());
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "zzz" } });

    await screen.findByText("No results for “zzz”.");
  });

  test("selecting a result records it as a recent search for next time", async () => {
    renderTrigger(await loadTrigger());
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "ahmad" } });
    await screen.findByText("Ahmad Ali");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Student profile");

    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("Recent searches");
    expect(screen.getByText("ahmad")).toBeTruthy();
  });

  test("clicking a recent search re-runs it instead of closing the palette", async () => {
    window.localStorage.setItem("studafy.global-search.recent.v1", JSON.stringify(["ahmad"]));

    renderTrigger(await loadTrigger());
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    fireEvent.click(await screen.findByText("ahmad"));

    await screen.findByText("Ahmad Ali");
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("has no accessibility violations with results shown", async () => {
    const { container } = renderTrigger(await loadTrigger());
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "ahmad" } });
    await screen.findByText("Ahmad Ali");

    await expectNoA11yViolations(container);
  });
});
