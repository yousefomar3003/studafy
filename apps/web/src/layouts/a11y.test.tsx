import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { expectNoA11yViolations } from "../lib/test/axe";

/**
 * Automated accessibility audit for the authenticated portal shell — header, sidebar nav, and the
 * notification bell / user menu popovers — rendered together via `PortalLayout` itself, since that
 * is the one component tree present on every `/portal/*` route (`RootLayout > PortalLayout >
 * <page>`, per `routes.tsx`). Each feature page's own `a11y.test.tsx` covers its content; this file
 * is the one place the shell around it gets checked.
 */

const getMock = mock((path: string) => {
  if (path === "/api/notifications/unread-count") {
    return Promise.resolve({ data: { unread_count: 1 } });
  }
  if (path === "/api/notifications") {
    return Promise.resolve({ data: { next_cursor: null, notifications: [] } });
  }
  return Promise.resolve({ data: { sessions: [], devices: [] } });
});
mock.module("../lib/api", () => ({ api: { GET: getMock, POST: getMock, DELETE: getMock } }));

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches access-token-claims.test.ts. */
function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderShell() {
  const { AuthProvider, createSessionStore } = await import("../lib/auth");
  const { PortalLayout } = await import("./PortalLayout");

  const store = createSessionStore({
    refreshClient: {
      refresh: async () => ({
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
    <QueryClientProvider client={queryClient}>
      <AuthProvider store={store}>
        <MemoryRouter initialEntries={["/portal"]}>
          <main id="main">
            <PortalLayout />
          </main>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("portal shell accessibility", () => {
  test("collapsed", async () => {
    const { container } = await renderShell();
    await screen.findByRole("navigation", { name: "Portal" });
    await screen.findByRole("button", { name: /notifications, 1 unread/i });

    await expectNoA11yViolations(container);
  });

  test("with the notification panel and the user menu open", async () => {
    const { container } = await renderShell();
    await screen.findByRole("navigation", { name: "Portal" });

    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    await screen.findByText("You’re all caught up.");
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));

    await expectNoA11yViolations(container);
  });
});
