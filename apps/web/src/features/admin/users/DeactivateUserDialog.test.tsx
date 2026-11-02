import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { usersListQueryKey } from "./queries";

import type { UsersFilters, UserWithRoles } from "./queries";
import type { ComponentType } from "react";

const USER: UserWithRoles = {
  id: "user-1",
  school_id: "school-1",
  email: "jamie@example.edu",
  display_name: "Jamie Chen",
  status: "active",
  roles: ["INSTRUCTOR"],
  email_verified_at: "2026-08-01T00:00:00.000Z",
  last_login_at: "2026-08-10T12:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const FILTERS: UsersFilters = { search: "", role: "", status: "", dateRange: {} };

const getMock = mock((path: string) => {
  if (path === "/api/admin/users/{userId}/sessions") {
    return Promise.resolve<unknown>({ data: { sessions: [] } });
  }
  return Promise.resolve<unknown>({ data: { devices: [] } });
});
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));

mock.module("../../../lib/api", () => ({ api: { GET: getMock, PATCH: patchMock } }));

const noop = () => undefined;

const loadDeactivateUserDialog = async (): Promise<ComponentType<{ user: UserWithRoles }>> => {
  const { DeactivateUserDialog } = await import("./DeactivateUserDialog");
  return ({ user }) => <DeactivateUserDialog user={user} onClose={noop} />;
};

function renderWithSeededList(Dialog: ComponentType<{ user: UserWithRoles }>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const listKey = usersListQueryKey(FILTERS, undefined);
  queryClient.setQueryData(listKey, { users: [USER], next_cursor: null });

  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Dialog user={USER} />
      </ToastProvider>
    </QueryClientProvider>,
  );

  return { queryClient, listKey };
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  patchMock.mockReset();
  patchMock.mockImplementation(() => Promise.resolve<unknown>({ data: {} }));
});

describe("DeactivateUserDialog", () => {
  test("shows the real session/device counts before confirming", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/api/admin/users/{userId}/sessions") {
        return Promise.resolve<unknown>({ data: { sessions: [{ id: "s1" }, { id: "s2" }] } });
      }
      return Promise.resolve<unknown>({ data: { devices: [{ id: "d1" }] } });
    });

    renderWithSeededList(await loadDeactivateUserDialog());

    expect(
      await screen.findByText(
        "This will end 2 active sessions across 1 device, and cancel any pending invitations for this account.",
      ),
    ).toBeTruthy();
  });

  test("optimistically suspends the row, then rolls back when the request fails", async () => {
    // A manually-controlled promise, not an immediately-rejected one: the point of this test is to
    // observe the optimistic state *while the request is still in flight*, which a promise that
    // rejects on the same microtask would make racy against `waitFor`'s first poll.
    let rejectPatch!: (error: Error) => void;
    patchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPatch = reject;
        }),
    );

    const { queryClient, listKey } = renderWithSeededList(await loadDeactivateUserDialog());
    await screen.findByRole("button", { name: "Deactivate" });

    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    // onMutate has run and patched the cache; the request itself is still pending.
    await waitFor(() => {
      const cached = queryClient.getQueryData(listKey) as { users: UserWithRoles[] };
      expect(cached.users[0]!.status).toBe("suspended");
    });

    rejectPatch(new Error("network down"));

    // onError restores the pre-mutation snapshot once the request actually fails.
    await waitFor(() => {
      const cached = queryClient.getQueryData(listKey) as { users: UserWithRoles[] };
      expect(cached.users[0]!.status).toBe("active");
    });

    expect(within(document.body).getByText("Couldn't deactivate user")).toBeTruthy();
  });

  test("keeps the optimistic suspension on success", async () => {
    patchMock.mockImplementation(() =>
      Promise.resolve<unknown>({
        data: { status: "suspended", revoked: 2, denylisted: 2, invitations_revoked: 0 },
      }),
    );

    const { queryClient, listKey } = renderWithSeededList(await loadDeactivateUserDialog());
    await screen.findByRole("button", { name: "Deactivate" });

    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => {
      const cached = queryClient.getQueryData(listKey) as { users: UserWithRoles[] };
      expect(cached.users[0]!.status).toBe("suspended");
    });

    expect(within(document.body).getByText("Jamie Chen deactivated")).toBeTruthy();
  });
});
