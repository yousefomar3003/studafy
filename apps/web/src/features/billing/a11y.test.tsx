import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";

import type { SessionTokens } from "../../lib/auth";
import type { ComponentType } from "react";

/** Automated accessibility audit for the AI add-on purchase screen, mirroring
 * `finance/adjustments/a11y.test.tsx`. */

const AI_OFFER = {
  price: { id: "price-1", amountMinor: 499, currency: "USD", interval: "monthly" },
  students: [
    { id: "student-1", name: "Amina Hassan", active: false },
    { id: "student-2", name: "Omar Hassan", active: true },
  ],
};

const getMock = mock((path: string) => {
  if (path === "/api/subscriptions/ai/offer") {
    return Promise.resolve({ data: AI_OFFER });
  }
  return Promise.resolve({ data: undefined });
});
mock.module("../../lib/api", () => ({
  api: { GET: getMock, POST: mock(() => Promise.resolve({ data: undefined })) },
}));

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderInPortal(Page: ComponentType, initialPath: string, routePath: string) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: ["ORG_ADMIN"], sub: "user-current" }),
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
          <MemoryRouter initialEntries={[initialPath]}>
            <main>
              <Routes>
                <Route path={routePath} element={<Page />} />
              </Routes>
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
});

describe("AI purchase screen accessibility", () => {
  test("AI subscription purchase, with the price and a student to buy for", async () => {
    const Page = (await import("./AiSubscriptionPurchasePage")).default;
    const { container } = await renderInPortal(Page, "/account/ai", "/account/ai");
    await screen.findByRole("button", { name: "Get AI for Amina Hassan" });

    await expectNoA11yViolations(container);
  });

  test("AI subscription purchase, success state", async () => {
    const Page = (await import("./AiSubscriptionPurchasePage")).default;
    const { container } = await renderInPortal(Page, "/account/ai?checkout=success", "/account/ai");
    await screen.findByRole("heading", { name: /all set/ });

    await expectNoA11yViolations(container);
  });
});
