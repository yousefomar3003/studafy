import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

const NOW = "2026-08-17T09:00:00.000Z";

const ENTRY_WITH_DIFF: Record<string, unknown> = {
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

function pageResponse(items: Record<string, unknown>[]) {
  return {
    generated_at: NOW,
    filter: { from: NOW, to: NOW },
    limit: 100,
    items,
    next_cursor: null,
    has_more: false,
  };
}

function defaultGetImplementation(path: string, _init?: unknown) {
  if (path === "/api/audit/logs") {
    return Promise.resolve<unknown>({ data: pageResponse([ENTRY_WITH_DIFF]) });
  }
  if (path === "/api/users") {
    return Promise.resolve<unknown>({ data: { users: [], next_cursor: null } });
  }
  return Promise.resolve<unknown>({ data: {} });
}

const getMock = mock(defaultGetImplementation);

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: getMock, PATCH: getMock, DELETE: getMock },
}));

const loadAuditLogExplorerPage = async (): Promise<ComponentType> =>
  (await import("./AuditLogExplorerPage")).default;

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches
 * `students/StudentsListPage.test.tsx` and `access-token-claims.test.ts`. */
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
            <Page />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  getMock.mockImplementation(defaultGetImplementation);
});

describe("AuditLogExplorerPage", () => {
  test("renders the audit entries returned by the list endpoint", async () => {
    await renderAsOrgAdmin(await loadAuditLogExplorerPage());

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    const grid = within(screen.getByRole("region", { name: "Audit log entries" }));
    expect(grid.getByText("Updated")).toBeTruthy();
  });

  test("renders an empty-state message when no entries match", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/api/audit/logs") {
        return Promise.resolve<unknown>({ data: pageResponse([]) });
      }
      return Promise.resolve<unknown>({ data: { users: [], next_cursor: null } });
    });

    await renderAsOrgAdmin(await loadAuditLogExplorerPage());

    expect(await screen.findByText("No entries match these filters.")).toBeTruthy();
  });

  test("changing the action filter refetches with the selected action", async () => {
    await renderAsOrgAdmin(await loadAuditLogExplorerPage());
    await screen.findByText("Ada Lovelace");
    getMock.mockClear();

    fireEvent.click(screen.getByRole("combobox", { name: "Action" }));
    fireEvent.click(screen.getByRole("option", { name: "Updated" }));

    await waitFor(() => {
      const call = getMock.mock.calls.find(([path]) => path === "/api/audit/logs");
      expect(call).toBeDefined();
      const init = call?.[1] as { params: { query: { action?: string } } } | undefined;
      expect(init?.params.query.action).toBe("update");
    });
  });

  test("opening the diff viewer shows the changed field, before and after", async () => {
    await renderAsOrgAdmin(await loadAuditLogExplorerPage());
    await screen.findByText("Ada Lovelace");

    fireEvent.click(screen.getByRole("button", { name: "View diff" }));

    const dialog = await screen.findByRole("dialog", { name: "Audit entry diff" });
    const dialogScope = within(dialog);
    expect(dialogScope.getByText("status")).toBeTruthy();
    expect(dialogScope.getByText("active")).toBeTruthy();
    expect(dialogScope.getByText("suspended")).toBeTruthy();
  });

  test("an entry with no before/after snapshot has no diff button", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/api/audit/logs") {
        return Promise.resolve<unknown>({
          data: pageResponse([
            {
              ...ENTRY_WITH_DIFF,
              id: "audit-2",
              action: "read",
              old_values: null,
              new_values: null,
            },
          ]),
        });
      }
      return Promise.resolve<unknown>({ data: { users: [], next_cursor: null } });
    });

    await renderAsOrgAdmin(await loadAuditLogExplorerPage());
    await screen.findByText("Ada Lovelace");

    expect(screen.queryByRole("button", { name: "View diff" })).toBeNull();
  });
});
