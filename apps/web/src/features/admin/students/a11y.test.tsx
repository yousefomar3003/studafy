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
 * Automated accessibility audit for the student-management screens, mirroring
 * `admin/users/a11y.test.tsx` — one render per representative state inside a `<main>`, matching how
 * `RootLayout` wraps every route. Unlike the users/invitations features, `StudentsListPage` and
 * `StudentProfilePage` read `usePermissions()` directly (for field-level visibility — see their
 * doc comments), so rendering them needs a real `AuthProvider`/session store, not just the query
 * client and toast provider the sibling features' tests use.
 */

const STUDENT = {
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
  status: "enrolled" as const,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const getMock = mock((path: string) => {
  if (path === "/api/academics/classes") {
    return Promise.resolve<unknown>({ data: { classes: [], total: 0 } });
  }
  return Promise.resolve<unknown>({ data: { students: [STUDENT], next_cursor: null } });
});
const postMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));
const deleteMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock, DELETE: deleteMock },
}));

const loadStudentsListPage = async (): Promise<ComponentType> =>
  (await import("./StudentsListPage")).default;
const loadImportStudentsPage = async (): Promise<ComponentType> =>
  (await import("./ImportStudentsPage")).default;

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
  patchMock.mockClear();
  deleteMock.mockClear();
});

describe("students feature accessibility", () => {
  test("student directory", async () => {
    const { container } = await renderAsOrgAdmin(await loadStudentsListPage());
    await screen.findByText("Amara Chen");

    await expectNoA11yViolations(container);
  });

  test("create-student modal open", async () => {
    const { container } = await renderAsOrgAdmin(await loadStudentsListPage());
    await screen.findByText("Amara Chen");

    fireEvent.click(screen.getByRole("button", { name: "New student" }));
    await screen.findByRole("dialog", { name: "New student" });

    await expectNoA11yViolations(container);
  });

  // The import flow's own steps beyond upload (progress, summary) turn on a real XHR-based upload
  // (see ImportStudentsPage.test.tsx), which needs mocking this file's shared `AuthProvider` setup
  // doesn't provide — the upload step alone, gated by nothing but the route, is what's covered here.
  test("import students page — upload step", async () => {
    const Page = await loadImportStudentsPage();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <main>
              <Page />
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "Download CSV template" });

    await expectNoA11yViolations(container);
  });
});
