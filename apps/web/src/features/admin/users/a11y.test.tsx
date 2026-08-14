import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the user-management screens, mirroring
 * `routes/onboarding-setup/a11y.test.tsx` — one render per representative state (the list, and the
 * create-user modal open on top of it) inside a `<main>`, matching how `RootLayout` wraps every route.
 */

const USER = {
  id: "user-1",
  school_id: "school-1",
  email: "jamie@example.edu",
  display_name: "Jamie Chen",
  status: "active" as const,
  roles: ["INSTRUCTOR"] as const,
  email_verified_at: "2026-08-01T00:00:00.000Z",
  last_login_at: "2026-08-10T12:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const getMock = mock((_path: string) =>
  Promise.resolve<unknown>({ data: { users: [USER], next_cursor: null } }),
);
const postMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock },
}));

const loadUsersListPage = async (): Promise<ComponentType> =>
  (await import("./UsersListPage")).default;

function renderInMain(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <main>
          <Page />
        </main>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
});

describe("users feature accessibility", () => {
  test("user list", async () => {
    const { container } = renderInMain(await loadUsersListPage());
    await screen.findByText("Jamie Chen");

    await expectNoA11yViolations(container);
  });

  test("create-user modal open", async () => {
    const { container } = renderInMain(await loadUsersListPage());
    await screen.findByText("Jamie Chen");

    fireEvent.click(screen.getByRole("button", { name: "New user" }));
    await screen.findByRole("dialog", { name: "New user" });

    await expectNoA11yViolations(container);
  });
});
