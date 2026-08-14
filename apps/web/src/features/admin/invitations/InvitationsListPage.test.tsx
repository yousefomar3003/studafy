import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ComponentType } from "react";

const INVITATION: Record<string, unknown> = {
  id: "invitation-1",
  email: "jamie@example.edu",
  role: "INSTRUCTOR",
  status: "pending",
  expires_at: "2026-08-22T00:00:00.000Z",
  revoked_at: null,
  consumed_at: null,
  invited_by_user_id: "user-1",
  created_at: "2026-08-15T00:00:00.000Z",
};

const BULK_INVITE: Record<string, unknown> = {
  id: "bulk-1",
  status: "completed",
  role: "STUDENT",
  expiry_days: 7,
  target_mode: "explicit",
  total_count: 3,
  sent_count: 3,
  failed_count: 0,
  created_at: "2026-08-14T00:00:00.000Z",
  updated_at: "2026-08-14T00:05:00.000Z",
  completed_at: "2026-08-14T00:05:00.000Z",
};

const DEFAULT_RESPONSE = {
  invitations: [INVITATION],
  next_cursor: null,
  bulk_invites: [BULK_INVITE],
};

const getMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: DEFAULT_RESPONSE }),
);
const postMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadInvitationsListPage = async (): Promise<ComponentType> =>
  (await import("./InvitationsListPage")).default;

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
  postMock.mockReset();
  getMock.mockImplementation(() => Promise.resolve<unknown>({ data: DEFAULT_RESPONSE }));
  postMock.mockImplementation(() => Promise.resolve<unknown>({ data: {} }));
});

describe("InvitationsListPage", () => {
  test("renders the invitations returned by the list endpoint", async () => {
    renderPage(await loadInvitationsListPage());

    const grid = within(screen.getByRole("region", { name: "Invitations" }));
    expect(await grid.findByText("jamie@example.edu")).toBeTruthy();
    expect(grid.getByText("Instructor")).toBeTruthy();
    expect(grid.getByText("Pending")).toBeTruthy();
  });

  test("renders an empty-state message when no invitations match", async () => {
    getMock.mockImplementation(() =>
      Promise.resolve<unknown>({ data: { invitations: [], next_cursor: null, bulk_invites: [] } }),
    );

    renderPage(await loadInvitationsListPage());

    expect(await screen.findByText("No invitations match these filters.")).toBeTruthy();
  });

  test("changing the status filter refetches with the selected status", async () => {
    renderPage(await loadInvitationsListPage());
    await screen.findByText("jamie@example.edu");
    getMock.mockClear();

    fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
    fireEvent.click(screen.getByRole("option", { name: "Revoked" }));

    await waitFor(() => {
      const call = getMock.mock.calls.find(([path]) => path === "/api/invitations");
      expect(call).toBeDefined();
      const init = call?.[1] as { params: { query: { status?: string } } } | undefined;
      expect(init?.params.query.status).toBe("revoked");
    });
  });

  test("opening the new-invitation modal does not fetch anything else", async () => {
    renderPage(await loadInvitationsListPage());
    await screen.findByText("jamie@example.edu");

    fireEvent.click(screen.getByRole("button", { name: "New invitation" }));

    expect(await screen.findByRole("dialog", { name: "New invitation" })).toBeTruthy();
  });

  test("switching to the Bulk invites tab renders bulk batches", async () => {
    renderPage(await loadInvitationsListPage());
    await screen.findByText("jamie@example.edu");

    fireEvent.click(screen.getByRole("tab", { name: "Bulk invites" }));

    const grid = within(screen.getByRole("region", { name: "Bulk invite batches" }));
    expect(await grid.findByText("Completed")).toBeTruthy();
    expect(grid.getByText("Student")).toBeTruthy();
  });
});
