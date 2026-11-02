import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

/**
 * Automated accessibility audit for announcement management (ST-194), mirroring
 * `audit/a11y.test.tsx` — one render per representative state inside a `<main>`, matching how
 * `RootLayout` wraps every route.
 */

const getMock = mock((path: string) => {
  if (path === "/api/announcements") {
    return Promise.resolve<unknown>({ data: { items: [], next_cursor: null } });
  }
  if (path === "/api/academics/classes") {
    return Promise.resolve<unknown>({ data: { classes: [], total: 0 } });
  }
  return Promise.resolve<unknown>({ data: {} });
});
const postMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: postMock, DELETE: postMock },
}));

const loadAnnouncementsPage = async (): Promise<ComponentType> =>
  (await import("./AnnouncementsPage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAsOrgAdmin(Page: ComponentType) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: ["ORG_ADMIN"] }),
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
        <ToastProvider>
          <MemoryRouter>
            <main>
              <Page />
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("announcement management accessibility", () => {
  test("compose tab, school audience (default)", async () => {
    const { container } = await renderAsOrgAdmin(await loadAnnouncementsPage());
    await screen.findByRole("heading", { name: "Announcements" });

    await expectNoA11yViolations(container);
  });

  test("compose tab, role audience selected", async () => {
    const { container } = await renderAsOrgAdmin(await loadAnnouncementsPage());
    await screen.findByRole("heading", { name: "Announcements" });

    fireEvent.click(screen.getByRole("radio", { name: "Everyone with a role" }));
    await screen.findByRole("combobox", { name: "Role" });

    await expectNoA11yViolations(container);
  });

  test("history tab", async () => {
    const { container } = await renderAsOrgAdmin(await loadAnnouncementsPage());
    await screen.findByRole("heading", { name: "Announcements" });

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    await screen.findByText("No announcements yet.");

    await expectNoA11yViolations(container);
  });
});
