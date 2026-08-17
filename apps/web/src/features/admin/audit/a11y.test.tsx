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
 * Automated accessibility audit for the audit log explorer (ST-193), mirroring
 * `students/a11y.test.tsx` — one render per representative state inside a `<main>`, matching how
 * `RootLayout` wraps every route.
 */

const NOW = "2026-08-17T09:00:00.000Z";

const ENTRY_WITH_DIFF = {
  id: "audit-1",
  created_at: NOW,
  action: "update",
  actor_id: "user-1",
  actor_name: "Ada Lovelace",
  actor_email: "ada@example.edu",
  target_table: "students",
  target_id: "student-12345678",
  client_ip: "10.0.0.1",
  user_agent: "test-agent",
  request_id: "req-1",
  old_values: { status: "active" },
  new_values: { status: "suspended" },
};

const getMock = mock((path: string) => {
  if (path === "/api/audit/logs") {
    return Promise.resolve<unknown>({
      data: {
        generated_at: NOW,
        filter: { from: NOW, to: NOW },
        limit: 100,
        items: [ENTRY_WITH_DIFF],
        next_cursor: null,
        has_more: false,
      },
    });
  }
  if (path === "/api/users") {
    return Promise.resolve<unknown>({ data: { users: [], next_cursor: null } });
  }
  return Promise.resolve<unknown>({ data: {} });
});
const postMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: postMock, DELETE: postMock },
}));

const loadAuditLogExplorerPage = async (): Promise<ComponentType> =>
  (await import("./AuditLogExplorerPage")).default;

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches
 * `students/a11y.test.tsx` and `access-token-claims.test.ts`. */
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

describe("audit log explorer accessibility", () => {
  test("audit log explorer", async () => {
    const { container } = await renderAsOrgAdmin(await loadAuditLogExplorerPage());
    await screen.findByText("Ada Lovelace");

    await expectNoA11yViolations(container);
  });

  test("diff modal open", async () => {
    const { container } = await renderAsOrgAdmin(await loadAuditLogExplorerPage());
    await screen.findByText("Ada Lovelace");

    fireEvent.click(screen.getByRole("button", { name: "View diff" }));
    await screen.findByRole("dialog", { name: "Audit entry diff" });

    await expectNoA11yViolations(container);
  });
});
