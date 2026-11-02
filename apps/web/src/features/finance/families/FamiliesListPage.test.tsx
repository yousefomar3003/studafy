import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType } from "react";

let summary = { students: 3, parents: 1 };

const getMock = mock((path: string) => {
  if (path === "/api/finance/families") {
    return Promise.resolve<unknown>({ data: { families: [], total: 0 } });
  }
  if (path === "/api/finance/unlinked/summary") {
    return Promise.resolve<unknown>({ data: summary });
  }
  return Promise.resolve<unknown>({ data: {} });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: getMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./FamiliesListPage")).default;

async function renderPage() {
  const Page = await loadPage();
  const store = await createTestSessionStore(["FINANCE"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <Page />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  summary = { students: 3, parents: 1 };
  getMock.mockClear();
});

describe("FamiliesListPage", () => {
  test("counts the students and parents no family reaches, linking to where they are fixed", async () => {
    await renderPage();

    const notice = await screen.findByText(/Not in any family/);
    expect(notice.textContent).toContain("enrolled students with no guardian: 3");
    expect(notice.textContent).toContain("parents with no children: 1");
    const banner = notice.closest("[role=status]") as HTMLElement;
    expect(
      within(banner).getByRole("link", { name: "Review and link them" }).getAttribute("href"),
    ).toBe("/portal/finance/unlinked");
  });

  test("shows no count when everyone is linked", async () => {
    summary = { students: 0, parents: 0 };
    await renderPage();

    await screen.findByRole("heading", { name: "Families" });
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/finance/unlinked/summary"));
    // Let the summary's response render before asserting it shows nothing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/Not in any family/)).toBeNull();
  });
});
