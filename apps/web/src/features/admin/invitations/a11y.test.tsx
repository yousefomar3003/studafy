import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the invitation-management screens, mirroring
 * `features/admin/users/a11y.test.tsx` — one render per representative state (the list, the
 * new-invitation modal, and the bulk-invite modal) inside a `<main>`, matching how `RootLayout`
 * wraps every route.
 */

const INVITATION = {
  id: "invitation-1",
  email: "jamie@example.edu",
  role: "INSTRUCTOR",
  status: "pending" as const,
  expires_at: "2026-08-22T00:00:00.000Z",
  revoked_at: null,
  consumed_at: null,
  invited_by_user_id: "user-1",
  created_at: "2026-08-15T00:00:00.000Z",
};

const DEFAULT_RESPONSE = { invitations: [INVITATION], next_cursor: null, bulk_invites: [] };

const getMock = mock((_path: string) => Promise.resolve<unknown>({ data: DEFAULT_RESPONSE }));
const postMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadInvitationsListPage = async (): Promise<ComponentType> =>
  (await import("./InvitationsListPage")).default;

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
});

describe("invitations feature accessibility", () => {
  test("invitations list", async () => {
    const { container } = renderInMain(await loadInvitationsListPage());
    await screen.findByText("jamie@example.edu");

    await expectNoA11yViolations(container);
  });

  test("new-invitation modal open", async () => {
    const { container } = renderInMain(await loadInvitationsListPage());
    await screen.findByText("jamie@example.edu");

    fireEvent.click(screen.getByRole("button", { name: "New invitation" }));
    await screen.findByRole("dialog", { name: "New invitation" });

    await expectNoA11yViolations(container);
  });

  test("bulk-invite modal open", async () => {
    const { container } = renderInMain(await loadInvitationsListPage());
    await screen.findByText("jamie@example.edu");

    fireEvent.click(screen.getByRole("tab", { name: "Bulk invites" }));
    fireEvent.click(screen.getByRole("button", { name: "New bulk invite" }));
    await screen.findByRole("dialog", { name: "Bulk invite" });

    await expectNoA11yViolations(container);
  });
});
