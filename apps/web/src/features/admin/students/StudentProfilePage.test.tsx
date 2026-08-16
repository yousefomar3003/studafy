import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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

const PARENT_USER: Record<string, unknown> = {
  id: "parent-1",
  school_id: "school-1",
  email: "morgan@example.edu",
  display_name: "Morgan Lee",
  status: "active",
  roles: ["PARENT"],
  email_verified_at: null,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

let guardians: Record<string, unknown>[] = [];

interface RequestInit {
  params?: { path?: Record<string, string>; query?: Record<string, unknown> };
  body?: Record<string, unknown>;
}

const getMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/students/{studentId}") {
    return Promise.resolve<unknown>({ data: STUDENT });
  }
  if (path === "/api/students/{studentId}/guardians") {
    return Promise.resolve<unknown>({ data: guardians });
  }
  if (path === "/api/users/{userId}") {
    return Promise.resolve<unknown>({ data: PARENT_USER });
  }
  if (path === "/api/users") {
    return Promise.resolve<unknown>({ data: { users: [PARENT_USER], next_cursor: null } });
  }
  if (path === "/api/academics/classes") {
    return Promise.resolve<unknown>({ data: { classes: [], total: 0 } });
  }
  if (path === "/api/academics/classes/{classId}/enrollments") {
    return Promise.resolve<unknown>({ data: { enrollments: [], total: 0 } });
  }
  return Promise.resolve<unknown>({ data: {} });
});

const postMock = mock((path: string, init?: RequestInit) => {
  if (path === "/api/students/{studentId}/guardians" && init?.body) {
    const guardian = {
      parent_user_id: init.body.parent_user_id,
      relationship: init.body.relationship,
      family_id: "family-1",
    };
    guardians = [...guardians, guardian];
    return Promise.resolve<unknown>({ data: guardian });
  }
  return Promise.resolve<unknown>({ data: {} });
});

const patchMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({ data: STUDENT }),
);

const deleteMock = mock((path: string, init?: RequestInit) => {
  if (path === "/api/students/{studentId}/guardians/{userId}") {
    const userId = init?.params?.path?.userId;
    guardians = guardians.filter((guardian) => guardian.parent_user_id !== userId);
  }
  return Promise.resolve<unknown>({ data: undefined });
});

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock, DELETE: deleteMock },
}));

const loadStudentProfilePage = async (): Promise<ComponentType> =>
  (await import("./StudentProfilePage")).default;

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches
 * `require-permission.test.tsx` and `access-token-claims.test.ts`. */
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
          <MemoryRouter initialEntries={["/portal/admin/students/student-1"]}>
            <Routes>
              <Route path="/portal/admin/students/:studentId" element={<Page />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  guardians = [];
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
  deleteMock.mockClear();
});

describe("StudentProfilePage", () => {
  test("renders demographics and admission info for a billing-visible session", async () => {
    await renderAsOrgAdmin(await loadStudentProfilePage());

    expect(await screen.findByRole("heading", { name: "Amara Chen" })).toBeTruthy();
    expect(screen.getByText("ADM-2024-001")).toBeTruthy();
  });

  test("links a guardian end to end", async () => {
    await renderAsOrgAdmin(await loadStudentProfilePage());
    await screen.findByRole("heading", { name: "Amara Chen" });

    fireEvent.click(screen.getByRole("tab", { name: "Guardians" }));
    await screen.findByText("No guardians linked yet.");

    fireEvent.click(screen.getByRole("button", { name: "Add guardian" }));
    const dialog = await screen.findByRole("dialog", { name: "Add guardian" });

    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Search parents" }), {
      target: { value: "Morgan" },
    });
    fireEvent.click(await within(dialog).findByText("Morgan Lee"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Link guardian" }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalled();
    });
    await screen.findByText("Morgan Lee");
  });

  test("unlinks a guardian after confirming", async () => {
    guardians = [{ parent_user_id: "parent-1", relationship: "mother", family_id: "family-1" }];

    await renderAsOrgAdmin(await loadStudentProfilePage());
    await screen.findByRole("heading", { name: "Amara Chen" });

    fireEvent.click(screen.getByRole("tab", { name: "Guardians" }));
    await screen.findByText("Morgan Lee");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove guardian" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalled();
    });
    await screen.findByText("No guardians linked yet.");
  });
});
