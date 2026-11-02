import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

const UNREAD_NOTIFICATION = {
  id: "n-1",
  school_id: "school-1",
  user_id: "user-1",
  notification_type: "ASSIGNMENT_DUE_SOON",
  title: "Algebra homework due",
  body: "Homework 4 is due Friday.",
  metadata: {},
  read_at: null,
  created_at: "2026-08-10T09:00:00.000Z",
  updated_at: "2026-08-10T09:00:00.000Z",
};

const READ_NOTIFICATION = {
  id: "n-2",
  school_id: "school-1",
  user_id: "user-1",
  notification_type: "GRADE_POSTED",
  title: "Your quiz grade is ready",
  body: "Algebra quiz 2 has been graded.",
  metadata: {},
  read_at: "2026-08-09T09:00:00.000Z",
  created_at: "2026-08-09T09:00:00.000Z",
  updated_at: "2026-08-09T09:00:00.000Z",
};

const getMock = mock(
  (path: string, options?: { params?: { query?: { unread_only?: string } } }) => {
    if (path === "/api/notifications") {
      const unreadOnly = options?.params?.query?.unread_only === "true";
      return Promise.resolve({
        data: {
          next_cursor: null,
          notifications: unreadOnly
            ? [UNREAD_NOTIFICATION]
            : [UNREAD_NOTIFICATION, READ_NOTIFICATION],
        },
      });
    }
    return Promise.resolve({ data: undefined });
  },
);

const postMock = mock((_path: string) => Promise.resolve({ data: { unread_count: 0 } }));

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./NotificationInboxPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("NotificationInboxPage", () => {
  test("lists notifications with their type label, newest first", async () => {
    renderPage(await loadPage());

    expect(await screen.findByText("Algebra homework due")).toBeTruthy();
    expect(screen.getByText("Your quiz grade is ready")).toBeTruthy();
    expect(screen.getByText("Assignment due soon")).toBeTruthy();
  });

  test("only the unread notification offers a mark-as-read action", async () => {
    renderPage(await loadPage());

    await screen.findByText("Algebra homework due");
    expect(screen.getAllByRole("button", { name: "Mark as read" })).toHaveLength(1);
  });

  test("marking a notification read calls the per-notification endpoint", async () => {
    renderPage(await loadPage());

    fireEvent.click(await screen.findByRole("button", { name: "Mark as read" }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/api/notifications/{notificationId}/read",
        expect.objectContaining({ params: { path: { notificationId: "n-1" } } }),
      );
    });
  });

  test("mark all as read calls the bulk endpoint", async () => {
    renderPage(await loadPage());

    fireEvent.click(await screen.findByRole("button", { name: "Mark all as read" }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith("/api/notifications/read-all");
    });
  });

  test("switching to the Unread filter re-fetches with unread_only", async () => {
    renderPage(await loadPage());

    await screen.findByText("Algebra homework due");
    getMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Unread" }));

    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(
        "/api/notifications",
        expect.objectContaining({
          params: expect.objectContaining({
            query: expect.objectContaining({ unread_only: "true" }),
          }),
        }),
      );
    });

    expect(screen.queryByText("Your quiz grade is ready")).toBeNull();
  });
});
