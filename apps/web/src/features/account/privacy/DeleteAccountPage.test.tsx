import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AuthProvider, createSessionStore } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";

let requests: unknown[] = [];

const getMock = mock((_path: string) => Promise.resolve({ data: requests }));
const postMock = mock((_path: string) =>
  Promise.resolve({
    data: {
      request_id: "dsr-1",
      status: "queued",
      requested_at: "2026-09-22T09:00:00.000Z",
      completes_by: "2026-10-22T09:00:00.000Z",
      ai_subscriptions_canceled: 1,
      retained_records: [
        { category: "academic_grades", description: "d", legal_basis: "b" },
        { category: "attendance", description: "d", legal_basis: "b" },
      ],
    },
  }),
);
let logoutCalls = 0;

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async () => (await import("./DeleteAccountPage")).default;

async function renderPage() {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createSessionStore({
    refreshClient: {
      refresh: async () => {
        throw new Error("not used");
      },
      logout: async () => {
        logoutCalls += 1;
      },
    },
  });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Page />
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  requests = [];
  getMock.mockClear();
  postMock.mockClear();
  logoutCalls = 0;
});

describe("DeleteAccountPage", () => {
  test("shows the delete action when there is no pending request", async () => {
    await renderPage();

    expect(await screen.findByRole("button", { name: "Delete my account" })).toBeTruthy();
  });

  test("asks for confirmation, and cancelling files no request", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete my account" }));
    expect(await screen.findByText("Delete your account?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(postMock).not.toHaveBeenCalled();
  });

  test("confirming deletes the account and shows the timeframe and retained records", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete my account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete account" }));

    expect(await screen.findByText("Your account is being deleted")).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith("/api/account/deletion", {});
    const completesBy = new Date("2026-10-22T09:00:00.000Z").toLocaleDateString();
    expect(screen.getByText(`erased by ${completesBy}`, { exact: false })).toBeTruthy();
    expect(screen.getByText("Your AI subscription won't renew.")).toBeTruthy();
    expect(screen.getByText("Grades, without your name or contact details")).toBeTruthy();
    expect(screen.getByText("Attendance, without your name or contact details")).toBeTruthy();
  });

  test("finishing signs out locally", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete my account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));

    await waitFor(() => expect(logoutCalls).toBe(1));
  });

  test("shows a pending request instead of the delete action", async () => {
    requests = [
      {
        id: "dsr-1",
        request_type: "erasure",
        subject_user_id: "user-1",
        status: "queued",
        created_at: "2026-09-22T09:00:00.000Z",
        completed_at: null,
        sla_due_at: "2026-10-22T09:00:00.000Z",
        download_url: null,
        download_url_expires_at: null,
        failure_message: null,
      },
    ];

    await renderPage();

    expect(await screen.findByText(/A deletion request is already in progress/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete my account" })).toBeNull();
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPage();
    await screen.findByRole("button", { name: "Delete my account" });

    await expectNoA11yViolations(container);
  });
});
