import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../lib/test/axe";

import type { ComponentType } from "react";

/** Automated accessibility audit for the notification inbox and preferences screens, mirroring
 * `billing/a11y.test.tsx`. */

const NOTIFICATION = {
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

const CHANNELS = ["in_app", "push", "email"] as const;
const PREFERENCES = ["ASSIGNMENT_DUE_SOON", "ADMIN_ANNOUNCEMENT", "DISCUSSION_REPLY"].flatMap(
  (notification_type) =>
    CHANNELS.map((channel) => ({
      notification_type,
      channel,
      enabled: true,
      digest: false,
      mandatory: notification_type === "ADMIN_ANNOUNCEMENT",
      digest_eligible: channel === "email" && notification_type === "DISCUSSION_REPLY",
    })),
);

const getMock = mock((path: string) => {
  if (path === "/api/notifications") {
    return Promise.resolve({ data: { next_cursor: null, notifications: [NOTIFICATION] } });
  }
  if (path === "/api/notification-preferences") {
    return Promise.resolve({
      data: { preferences: PREFERENCES, attendance_alert_threshold: null },
    });
  }
  return Promise.resolve({ data: undefined });
});

mock.module("../../lib/api", () => ({
  api: { GET: getMock, POST: mock(() => Promise.resolve({ data: undefined })) },
}));

async function renderInPortal(Page: ComponentType, path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <main>
            <Routes>
              <Route path="/portal/notifications" element={<Page />} />
              <Route path="/portal/notifications/preferences" element={<Page />} />
            </Routes>
          </main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("notifications screens accessibility", () => {
  test("inbox, populated with an unread notification", async () => {
    const Page = (await import("./NotificationInboxPage")).default;
    const { container } = await renderInPortal(Page, "/portal/notifications");
    await screen.findByText("Algebra homework due");

    await expectNoA11yViolations(container);
  });

  test("preferences, populated with the channel matrix", async () => {
    const Page = (await import("./NotificationPreferencesPage")).default;
    const { container } = await renderInPortal(Page, "/portal/notifications/preferences");
    await screen.findByText("School announcement");

    await expectNoA11yViolations(container);
  });
});
