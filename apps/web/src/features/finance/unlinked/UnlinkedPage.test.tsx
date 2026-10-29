import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType } from "react";

const UNLINKED_STUDENT = {
  id: "student-1",
  name: "Omar Saleh",
  admission_number: "ADM-002",
  created_at: "2026-08-01T00:00:00.000Z",
};

const UNLINKED_PARENT = {
  user_id: "parent-1",
  name: "Sami Alone",
  email: "sami@example.edu",
  status: "active",
  created_at: "2026-08-01T00:00:00.000Z",
};

const PICKABLE_STUDENT = {
  id: "student-9",
  school_id: "school-1",
  user_id: "user-9",
  first_name: "Lina",
  middle_name: null,
  last_name: "Haddad",
  preferred_name: null,
  date_of_birth: null,
  nationality_country_id: null,
  admission_number: "ADM-009",
  admission_date: null,
  status: "enrolled",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

interface RequestInit {
  params?: { path?: Record<string, string>; query?: Record<string, unknown> };
  body?: Record<string, unknown>;
}

const getMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/finance/unlinked/students") {
    return Promise.resolve<unknown>({ data: { students: [UNLINKED_STUDENT], total: 1 } });
  }
  if (path === "/api/finance/unlinked/parents") {
    return Promise.resolve<unknown>({ data: { parents: [UNLINKED_PARENT], total: 1 } });
  }
  if (path === "/api/students") {
    return Promise.resolve<unknown>({ data: { students: [PICKABLE_STUDENT], next_cursor: null } });
  }
  return Promise.resolve<unknown>({ data: {} });
});

const postMock = mock((_path: string, init?: RequestInit) =>
  Promise.resolve<unknown>({
    data: {
      family_id: "family-1",
      parent_user_id: init?.body?.parent_user_id,
      relationship: init?.body?.relationship,
      created_at: "",
    },
  }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./UnlinkedPage")).default;

async function renderAs(roles: string[]) {
  const Page = await loadPage();
  const store = await createTestSessionStore(roles);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/portal/finance/unlinked"]}>
            <Page />
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

describe("UnlinkedPage", () => {
  test("lists enrolled students with no guardian and parents with no children", async () => {
    await renderAs(["ORG_ADMIN"]);

    const students = await screen.findByRole("region", {
      name: "Enrolled students with no guardian",
    });
    expect(await within(students).findByText("Omar Saleh")).toBeTruthy();
    expect(within(students).getByText("ADM-002")).toBeTruthy();

    const parents = screen.getByRole("region", { name: "Parents with no children" });
    expect(await within(parents).findByText("Sami Alone")).toBeTruthy();
    expect(within(parents).getByText("sami@example.edu")).toBeTruthy();
  });

  test("a student row links to the student's Guardians tab", async () => {
    await renderAs(["ORG_ADMIN"]);

    const link = await screen.findByRole("link", { name: "Add a guardian" });
    expect(link.getAttribute("href")).toBe("/portal/admin/students/student-1?tab=guardians");
  });

  test("a parent row links the children staff pick, through the Guardians tab's own call", async () => {
    await renderAs(["ORG_ADMIN"]);

    fireEvent.click(await screen.findByRole("button", { name: "Link children to Sami Alone" }));
    const dialog = await screen.findByRole("dialog", { name: "Link children to Sami Alone" });

    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Search students" }), {
      target: { value: "Lina" },
    });
    fireEvent.click(await within(dialog).findByText("Lina Haddad"));
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Relationship of Lina Haddad" }));
    fireEvent.click(await screen.findByRole("option", { name: "Father" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Link children" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/students/{studentId}/guardians");
    expect(init.params?.path).toEqual({ studentId: "student-9" });
    expect(init.body).toEqual({ parent_user_id: "parent-1", relationship: "father" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("searching a list asks the API for that term", async () => {
    await renderAs(["ORG_ADMIN"]);
    await screen.findByText("Omar Saleh");

    const search = screen.getByRole("searchbox", { name: "Search students" });
    fireEvent.change(search, { target: { value: "omar" } });
    fireEvent.submit(search.closest("form")!);

    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith("/api/finance/unlinked/students", {
        params: { query: { search: "omar", limit: 20, offset: 0 } },
      }),
    );
  });

  test("finance, who cannot link, sees the lists with a note instead of the fixes", async () => {
    await renderAs(["FINANCE"]);

    expect(await screen.findByText("Omar Saleh")).toBeTruthy();
    expect(await screen.findByText("Sami Alone")).toBeTruthy();
    expect(screen.getAllByText("Ask a school admin to link them").length).toBe(2);
    expect(screen.queryByRole("link", { name: "Add a guardian" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link children to Sami Alone" })).toBeNull();
  });
});
