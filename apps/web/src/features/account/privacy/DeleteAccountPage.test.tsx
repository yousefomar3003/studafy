import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AuthProvider, createSessionStore } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";
import { TEST_PROFILE } from "../../../lib/test/session";

let requests: unknown[] = [];
let storeSubscriptions: unknown[] = [];

const getMock = mock((path: string) =>
  Promise.resolve({
    data:
      path === "/api/account/profile"
        ? { ...TEST_PROFILE, active_store_subscriptions: storeSubscriptions }
        : requests,
  }),
);
const postMock = mock((_path: string) =>
  Promise.resolve({
    data: {
      active_store_subscriptions: storeSubscriptions,
      status: "scheduled",
      requested_at: "2026-09-22T09:00:00.000Z",
      scheduled_for: "2026-10-06T09:00:00.000Z",
      completes_by: "2026-11-05T09:00:00.000Z",
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
  storeSubscriptions = [];
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

  test("confirming schedules the deletion and shows the dates and retained records", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete my account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete account" }));

    expect(await screen.findByText("Your account deletion is scheduled")).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith("/api/account/deletion", {});
    const scheduledFor = new Date("2026-10-06T09:00:00.000Z").toLocaleDateString();
    const completesBy = new Date("2026-11-05T09:00:00.000Z").toLocaleDateString();
    expect(screen.getByText(`deleted on ${scheduledFor}`, { exact: false })).toBeTruthy();
    expect(screen.getByText(`erased by ${completesBy}`, { exact: false })).toBeTruthy();
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

  test("warns before deleting that an App Store subscription keeps billing", async () => {
    storeSubscriptions = [{ platform: "app_store", for_child: false }];

    await renderPage();

    expect(
      await screen.findByRole("heading", {
        name: "Cancel your App Store or Google Play subscription",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Deleting your account doesn't cancel it/)).toBeTruthy();
    expect(screen.getByText(/^App Store: on the iPhone or iPad/)).toBeTruthy();
    expect(screen.queryByText(/^Google Play: open the Google Play app/)).toBeNull();
    // The delete action is still offered: the warning informs, it does not block.
    expect(screen.getByRole("button", { name: "Delete my account" })).toBeTruthy();
  });

  test("repeats the warning once the deletion is scheduled", async () => {
    storeSubscriptions = [{ platform: "google_play", for_child: true }];

    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete my account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete account" }));

    expect(await screen.findByText("Your account deletion is scheduled")).toBeTruthy();
    expect(screen.getByText(/A child linked to your account/)).toBeTruthy();
    expect(screen.getByText(/^Google Play: open the Google Play app/)).toBeTruthy();
  });

  test("shows no store warning without a store subscription", async () => {
    await renderPage();
    await screen.findByRole("button", { name: "Delete my account" });

    expect(
      screen.queryByRole("heading", { name: "Cancel your App Store or Google Play subscription" }),
    ).toBeNull();
  });

  test("has no accessibility violations", async () => {
    storeSubscriptions = [
      { platform: "app_store", for_child: false },
      { platform: "google_play", for_child: true },
    ];
    const { container } = await renderPage();
    await screen.findByRole("button", { name: "Delete my account" });

    await expectNoA11yViolations(container);
  });
});
