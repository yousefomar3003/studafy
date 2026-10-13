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

const AI_STUDENT = {
  id: "student-1",
  school_id: "school-1",
  user_id: "user-1",
  first_name: "Amina",
  middle_name: null,
  last_name: "Hassan",
  preferred_name: null,
  date_of_birth: null,
  nationality_country_id: null,
  status: "enrolled",
  admission_number: "",
  admission_date: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const getMock = mock((path: string) => {
  if (path === "/api/students/{studentId}") {
    return Promise.resolve({ data: AI_STUDENT });
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
  test("AI subscription purchase, populated with the student's plan explainer", async () => {
    const Page = (await import("./AiSubscriptionPurchasePage")).default;
    const { container } = await renderInPortal(
      Page,
      "/account/ai?studentId=student-1&priceId=price-1",
      "/account/ai",
    );
    await screen.findByText(/A personal AI tutor for Amina Hassan/);

    await expectNoA11yViolations(container);
  });

  test("AI subscription purchase, success state", async () => {
    const Page = (await import("./AiSubscriptionPurchasePage")).default;
    const { container } = await renderInPortal(
      Page,
      "/account/ai?studentId=student-1&priceId=price-1&checkout=success",
      "/account/ai",
    );
    await screen.findByRole("heading", { name: /all set/ });

    await expectNoA11yViolations(container);
  });
});
