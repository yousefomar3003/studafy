import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { createTestSessionStore } from "../../../lib/test/session";

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

/** Renders the router's current `search`, so a test can see a query parameter being dropped. */
function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

/** As an ORG_ADMIN: the page reads the session's permissions (the create modal's link step). */
async function renderPage(Page: ComponentType, initialEntry = "/portal/admin/users") {
  const store = await createTestSessionStore(["ORG_ADMIN"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <Page />
            <LocationProbe />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
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
    await renderPage(await loadUsersListPage());

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

    await renderPage(await loadUsersListPage());

    expect(await screen.findByText("No users match these filters.")).toBeTruthy();
  });

  test("changing the role filter refetches with the selected role", async () => {
    await renderPage(await loadUsersListPage());
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
    await renderPage(await loadUsersListPage());
    await screen.findByText("Jamie Chen");

    fireEvent.click(screen.getByRole("button", { name: "New user" }));

    expect(await screen.findByRole("dialog", { name: "New user" })).toBeTruthy();
  });

  test("the create-user modal refuses to submit without a name", async () => {
    await renderPage(await loadUsersListPage());
    await screen.findByText("Jamie Chen");

    fireEvent.click(screen.getByRole("button", { name: "New user" }));
    const dialog = await screen.findByRole("dialog", { name: "New user" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /email/i }), {
      target: { value: "new.teacher@example.edu" },
    });
    getMock.mockClear();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send invite" }));

    expect(await within(dialog).findByText("Name is required")).toBeTruthy();
    expect(getMock).not.toHaveBeenCalledWith("/api/users", expect.anything());
  });

  test("an admin who holds parent:link gets the link-children step for a new parent", async () => {
    await renderPage(await loadUsersListPage());
    await screen.findByText("Jamie Chen");

    fireEvent.click(screen.getByRole("button", { name: "New user" }));
    const dialog = await screen.findByRole("dialog", { name: "New user" });
    expect(within(dialog).queryByRole("group", { name: "Link children (optional)" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("combobox", { name: "Role" }));
    fireEvent.click(await screen.findByRole("option", { name: "Parent" }));

    expect(within(dialog).getByRole("group", { name: "Link children (optional)" })).toBeTruthy();
  });

  test("?create=PARENT opens the create-user modal on the parent role; closing drops it", async () => {
    getMock.mockImplementation((path: string) =>
      Promise.resolve<unknown>(
        path === "/api/record-forms/{subjectKind}"
          ? { data: { fields: [] } }
          : { data: { users: [USER], next_cursor: null } },
      ),
    );
    await renderPage(await loadUsersListPage(), "/portal/admin/users?create=PARENT");

    const dialog = await screen.findByRole("dialog", { name: "New user" });
    expect(within(dialog).getByRole("group", { name: "Link children (optional)" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New user" })).toBeNull());
    expect(screen.getByTestId("location-search").textContent).toBe("");
  });

  test("?create=1 opens the create-user modal on the default role", async () => {
    await renderPage(await loadUsersListPage(), "/portal/admin/users?create=1");

    const dialog = await screen.findByRole("dialog", { name: "New user" });
    expect(within(dialog).queryByRole("group", { name: "Link children (optional)" })).toBeNull();
  });
});
