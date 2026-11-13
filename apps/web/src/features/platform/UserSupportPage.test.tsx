import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { ComponentType } from "react";

/**
 * The console's per-account support page: it shows the account, how it signs in and who it is
 * linked to, offers only the actions that apply, sends each with its reason, and offers nothing
 * for another platform administrator's account.
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function account(overrides: Record<string, unknown> = {}) {
  return {
    school: { id: SCHOOL_ID, name: "Alpha Academy", status: "active" },
    userId: USER_ID,
    displayName: "Huda Ali",
    email: "huda@alpha.test",
    status: "active",
    roles: ["PARENT"],
    memberCodes: ["PAR-300001"],
    createdAt: "2026-08-01T00:00:00.000Z",
    lastLoginAt: "2026-11-01T08:00:00.000Z",
    activated: true,
    signIn: {
      providers: ["google"],
      memberPassword: false,
      locked: false,
      lockedUntil: null,
      failedAttempts: 0,
    },
    activeSessions: 2,
    invitation: null,
    children: [{ name: "Sara Ali", relationship: "mother" }],
    parents: [],
    actionable: true,
    isSelf: false,
    ...overrides,
  };
}

let current = account();

const getMock = mock((path: string) => {
  if (path === "/api/platform/schools/{schoolId}/users/{userId}") {
    return Promise.resolve({ data: current });
  }
  throw new Error(`Unhandled GET ${path}`);
});
const postMock = mock((path: string, _init: { body: { reason: string } }) => {
  if (path.endsWith("/sessions/revoke")) {
    current = account({ activeSessions: 0 });
    return Promise.resolve({ data: { revokedSessions: 2, denylistedTokens: 2 } });
  }
  if (path.endsWith("/deactivate")) {
    current = account({ status: "suspended", activeSessions: 0 });
    return Promise.resolve({
      data: { status: "suspended", revokedSessions: 2, invitationsRevoked: 0 },
    });
  }
  throw new Error(`Unhandled POST ${path}`);
});

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./UserSupportPage")).default;

async function renderPage() {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/portal/platform/schools/${SCHOOL_ID}/users/${USER_ID}`]}>
          <Routes>
            <Route path="/portal/platform/schools/:schoolId/users/:userId" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  current = account();
  getMock.mockClear();
  postMock.mockClear();
});

describe("UserSupportPage", () => {
  test("shows the account, its sign-in and its children by name", async () => {
    await renderPage();
    await screen.findByRole("heading", { name: "Huda Ali", level: 1 });
    expect(screen.getByText("huda@alpha.test")).toBeTruthy();
    expect(screen.getByText("Google")).toBeTruthy();
    expect(screen.getByText(/Sara Ali/)).toBeTruthy();
    expect(screen.getByText(/can't sign in as a school member/)).toBeTruthy();
  });

  test("offers only the actions that apply", async () => {
    await renderPage();
    await screen.findByRole("button", { name: "Sign out everywhere" });
    expect(screen.getByRole("button", { name: "Deactivate account" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-send invitation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlock sign-in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reactivate account" })).toBeNull();
  });

  test("an action needs a reason and sends it", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out everywhere" }));

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "Ticket 88: lost phone" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![0]).toBe(
      "/api/platform/schools/{schoolId}/users/{userId}/sessions/revoke",
    );
    expect(postMock.mock.calls[0]![1].body).toEqual({ reason: "Ticket 88: lost phone" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Sign out everywhere" })).toBeNull(),
    );
  });

  test("a deactivated account offers reactivation instead", async () => {
    current = account({ status: "suspended", activeSessions: 0 });
    await renderPage();
    expect(await screen.findByRole("button", { name: "Reactivate account" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deactivate account" })).toBeNull();
  });

  test("the operator's own account cannot be deactivated from here", async () => {
    current = account({ isSelf: true });
    await renderPage();
    await screen.findByRole("button", { name: "Sign out everywhere" });
    expect(screen.queryByRole("button", { name: "Deactivate account" })).toBeNull();
  });

  test("another platform administrator's account offers no action", async () => {
    current = account({ actionable: false, roles: ["SUPER_ADMIN"] });
    await renderPage();
    expect(await screen.findByText(/another Studafy platform administrator/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out everywhere" })).toBeNull();
  });
});
