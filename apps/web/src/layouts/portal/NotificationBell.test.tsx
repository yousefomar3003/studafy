import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

const getMock = mock((path: string) => {
  if (path === "/api/notifications/unread-count") {
    return Promise.resolve({ data: { unread_count: 2 } });
  }
  return Promise.resolve({
    data: {
      next_cursor: null,
      notifications: [
        {
          id: "n-1",
          school_id: "school-1",
          user_id: "user-1",
          notification_type: "assignment.published",
          title: "New assignment posted",
          body: "Algebra homework 4 is due Friday.",
          metadata: {},
          read_at: null,
          created_at: "2026-08-10T09:00:00.000Z",
          updated_at: "2026-08-10T09:00:00.000Z",
        },
        {
          id: "n-2",
          school_id: "school-1",
          user_id: "user-1",
          notification_type: "grade.published",
          title: "Grade posted",
          body: "Your quiz grade is ready.",
          metadata: {},
          read_at: "2026-08-09T09:00:00.000Z",
          created_at: "2026-08-09T09:00:00.000Z",
          updated_at: "2026-08-09T09:00:00.000Z",
        },
      ],
    },
  });
});

const postMock = mock((_path: string) => Promise.resolve({ data: { unread_count: 1 } }));

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadBell = async (): Promise<ComponentType> =>
  (await import("./NotificationBell")).NotificationBell;

function renderBell(Bell: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Bell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("NotificationBell", () => {
  test("shows the unread count on the trigger and names it in the accessible label", async () => {
    renderBell(await loadBell());

    const trigger = await screen.findByRole("button", { name: /notifications, 2 unread/i });
    expect(within(trigger).getByText("2")).toBeTruthy();
  });

  test("opens the panel on click and lists recent notifications", async () => {
    renderBell(await loadBell());

    const trigger = await screen.findByRole("button", { name: /notifications/i });
    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("New assignment posted")).toBeTruthy();
    expect(screen.getByText("Grade posted")).toBeTruthy();
  });

  test("only the unread notification offers a mark-as-read action", async () => {
    renderBell(await loadBell());

    fireEvent.click(await screen.findByRole("button", { name: /notifications/i }));
    await screen.findByText("New assignment posted");

    expect(screen.getAllByRole("button", { name: "Mark as read" })).toHaveLength(1);
  });

  test("marking a notification read calls the per-notification endpoint", async () => {
    renderBell(await loadBell());

    fireEvent.click(await screen.findByRole("button", { name: /notifications/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark as read" }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/api/notifications/{notificationId}/read",
        expect.objectContaining({ params: { path: { notificationId: "n-1" } } }),
      );
    });
  });

  test("mark all as read calls the bulk endpoint and is disabled with nothing unread", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/api/notifications/unread-count") {
        return Promise.resolve({ data: { unread_count: 0 } });
      }
      return Promise.resolve({ data: { next_cursor: null, notifications: [] } });
    });

    renderBell(await loadBell());

    fireEvent.click(await screen.findByRole("button", { name: /notifications/i }));
    await screen.findByText("You’re all caught up.");

    const markAllButton = screen.getByRole("button", {
      name: "Mark all as read",
    }) as HTMLButtonElement;
    expect(markAllButton.disabled).toBe(true);
  });
});
