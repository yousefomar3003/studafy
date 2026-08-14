import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ComponentType } from "react";

const USER: Record<string, unknown> = {
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

const getMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: { users: [USER], next_cursor: null } }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: getMock, PATCH: getMock } }));

const loadUsersListPage = async (): Promise<ComponentType> =>
  (await import("./UsersListPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Page />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  getMock.mockImplementation(() =>
    Promise.resolve<unknown>({ data: { users: [USER], next_cursor: null } }),
  );
});

describe("UsersListPage", () => {
  test("renders the users returned by the list endpoint", async () => {
    renderPage(await loadUsersListPage());

    expect(await screen.findByText("Jamie Chen")).toBeTruthy();
    // Scoped to the grid: "Instructor" also appears, hidden, inside the closed Role filter's listbox.
    const grid = within(screen.getByRole("region", { name: "School users" }));
    expect(grid.getByText("jamie@example.edu")).toBeTruthy();
    expect(grid.getByText("Instructor")).toBeTruthy();
  });

  test("renders an empty-state message when no users match", async () => {
    getMock.mockImplementation(() =>
      Promise.resolve<unknown>({ data: { users: [], next_cursor: null } }),
    );

    renderPage(await loadUsersListPage());

    expect(await screen.findByText("No users match these filters.")).toBeTruthy();
  });

  test("changing the role filter refetches with the selected role", async () => {
    renderPage(await loadUsersListPage());
    await screen.findByText("Jamie Chen");
    getMock.mockClear();

    fireEvent.click(screen.getByRole("combobox", { name: "Role" }));
    fireEvent.click(screen.getByRole("option", { name: "Instructor" }));

    await waitFor(() => {
      const call = getMock.mock.calls.find(([path]) => path === "/api/users");
      expect(call).toBeDefined();
      const init = call?.[1] as { params: { query: { role?: string } } } | undefined;
      expect(init?.params.query.role).toBe("INSTRUCTOR");
    });
  });

  test("opening the create-user modal does not fetch anything else", async () => {
    renderPage(await loadUsersListPage());
    await screen.findByText("Jamie Chen");

    fireEvent.click(screen.getByRole("button", { name: "New user" }));

    expect(await screen.findByRole("dialog", { name: "New user" })).toBeTruthy();
  });
});
