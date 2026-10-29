import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

const STUDENT: Record<string, unknown> = {
  id: "student-1",
  school_id: "school-1",
  user_id: "user-1",
  first_name: "Amara",
  middle_name: null,
  last_name: "Chen",
  preferred_name: null,
  date_of_birth: "2012-04-01",
  nationality_country_id: null,
  admission_number: "ADM-2024-001",
  admission_date: "2024-08-01",
  status: "enrolled",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

function defaultGetImplementation(path: string, _init?: unknown) {
  if (path === "/api/academics/classes") {
    return Promise.resolve<unknown>({ data: { classes: [], total: 0 } });
  }
  // The create modal's record step asks for the school's student form.
  if (path === "/api/record-forms/{subjectKind}") {
    return Promise.resolve<unknown>({ data: { fields: [] } });
  }
  return Promise.resolve<unknown>({ data: { students: [STUDENT], next_cursor: null } });
}

const getMock = mock(defaultGetImplementation);

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: getMock, PATCH: getMock, DELETE: getMock },
}));

const loadStudentsListPage = async (): Promise<ComponentType> =>
  (await import("./StudentsListPage")).default;

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches
 * `require-permission.test.tsx` and `access-token-claims.test.ts`. */
function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

/** Renders the router's current `search`, so a test can see a query parameter being dropped. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

async function renderAsOrgAdmin(Page: ComponentType, initialEntry = "/portal/admin/students") {
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
  getMock.mockImplementation(defaultGetImplementation);
});

describe("StudentsListPage", () => {
  test("renders the students returned by the list endpoint", async () => {
    await renderAsOrgAdmin(await loadStudentsListPage());

    expect(await screen.findByText("Amara Chen")).toBeTruthy();
    const grid = within(screen.getByRole("region", { name: "Students" }));
    expect(grid.getByText("ADM-2024-001")).toBeTruthy();
  });

  test("renders an empty-state message when no students match", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/api/academics/classes") {
        return Promise.resolve<unknown>({ data: { classes: [], total: 0 } });
      }
      return Promise.resolve<unknown>({ data: { students: [], next_cursor: null } });
    });

    await renderAsOrgAdmin(await loadStudentsListPage());

    expect(await screen.findByText("No students match these filters.")).toBeTruthy();
  });

  test("changing the status filter refetches with the selected status", async () => {
    await renderAsOrgAdmin(await loadStudentsListPage());
    await screen.findByText("Amara Chen");
    getMock.mockClear();

    fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
    fireEvent.click(screen.getByRole("option", { name: "Enrolled" }));

    await waitFor(() => {
      const call = getMock.mock.calls.find(([path]) => path === "/api/students");
      expect(call).toBeDefined();
      const init = call?.[1] as { params: { query: { status?: string } } } | undefined;
      expect(init?.params.query.status).toBe("enrolled");
    });
  });

  test("opening the create-student modal does not fetch anything else", async () => {
    await renderAsOrgAdmin(await loadStudentsListPage());
    await screen.findByText("Amara Chen");

    fireEvent.click(screen.getByRole("button", { name: "New student" }));

    expect(await screen.findByRole("dialog", { name: "New student" })).toBeTruthy();
  });

  test("?create=1 opens the create-student modal on arrival, and closing it drops the parameter", async () => {
    await renderAsOrgAdmin(await loadStudentsListPage(), "/portal/admin/students?create=1&q=x");

    expect(await screen.findByRole("dialog", { name: "New student" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New student" })).toBeNull());
    expect(screen.getByTestId("location-search").textContent).toBe("?q=x");
  });
});
