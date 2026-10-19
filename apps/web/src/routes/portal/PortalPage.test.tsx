import { ApiError } from "@studafy/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";
import { createTestSessionStore } from "../../lib/test/session";

import type { ComponentType } from "react";

// Mock the app client module before PortalPage is loaded, so the query hits this stub instead of the
// network. PortalPage is imported dynamically in each test, after the mock is registered.
const getMock = mock((_path: string) => Promise.resolve<unknown>({ data: { status: "ok" } }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadPortalPage = async (): Promise<ComponentType> => (await import("./PortalPage")).default;

async function renderPage(Page: ComponentType, initialPath = "/portal", roles = ["INSTRUCTOR"]) {
  const store = await createTestSessionStore(roles);
  // retry: false so a rejected query settles to its error state immediately.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <main>
            <Routes>
              <Route path="/portal" element={<Page />} />
              <Route path="/portal/principal" element={<h1>Principal home</h1>} />
            </Routes>
          </main>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("PortalPage health smoke test", () => {
  test("renders the typed /healthz status end-to-end", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { status: "ok" } }));

    await renderPage(await loadPortalPage());

    expect(await screen.findByText(/api status: ok/i)).toBeTruthy();
  });

  test("surfaces a typed ApiError's request_id to the UI on failure", async () => {
    const requestId = "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12";
    getMock.mockImplementation(() =>
      Promise.reject(
        new ApiError({
          status: 503,
          title: "Service Unavailable",
          code: null,
          detail: null,
          instance: null,
          type: null,
          request_id: requestId,
          problem: null,
        }),
      ),
    );

    await renderPage(await loadPortalPage());

    expect(
      await screen.findByText(new RegExp(`unavailable \\(ref ${requestId}\\)`, "i")),
    ).toBeTruthy();
  });
});

describe("PortalPage forbidden notice", () => {
  test("renders a notice when redirected here with ?notice=forbidden", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { status: "ok" } }));

    await renderPage(await loadPortalPage(), "/portal?notice=forbidden");

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toMatch(/don.t have access/i);
  });

  test("has no accessibility violations with the forbidden notice showing", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { status: "ok" } }));

    const { container } = await renderPage(await loadPortalPage(), "/portal?notice=forbidden");
    await screen.findByRole("alert");

    await expectNoA11yViolations(container);
  });

  test("renders no notice on a plain visit", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { status: "ok" } }));

    await renderPage(await loadPortalPage());

    await screen.findByText(/api status: ok/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("PortalPage role home forwarding", () => {
  test("forwards a role with its own home page there", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { status: "ok" } }));

    await renderPage(await loadPortalPage(), "/portal", ["PRINCIPAL"]);

    expect(await screen.findByRole("heading", { name: "Principal home" })).toBeTruthy();
  });

  test("stays put to show the forbidden notice", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { status: "ok" } }));

    await renderPage(await loadPortalPage(), "/portal?notice=forbidden", ["PRINCIPAL"]);

    expect((await screen.findByRole("alert")).textContent).toMatch(/don.t have access/i);
  });
});
