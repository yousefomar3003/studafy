import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

const CHANNELS = ["in_app", "push", "email"] as const;
const TYPES = [
  "ASSIGNMENT_DUE_SOON",
  "GRADE_POSTED",
  "ENROLLMENT_APPROVED",
  "COURSE_PUBLISHED",
  "DISCUSSION_REPLY",
  "STUDY_GROUP_INVITE",
  "CERTIFICATE_ISSUED",
  "SUPPORT_MESSAGE",
  "ATTENDANCE_ALERT",
  "ADMIN_ANNOUNCEMENT",
  "ANNOUNCEMENT",
  "MATERIAL_SCAN_QUARANTINED",
  "MATERIAL_SCAN_FAILED",
  "MATERIAL_OCR_LOW_CONFIDENCE",
  "MATERIAL_INGESTED",
  "MATERIAL_INGEST_FAILED",
];
const DIGEST_ELIGIBLE = new Set([
  "DISCUSSION_REPLY",
  "STUDY_GROUP_INVITE",
  "COURSE_PUBLISHED",
  "ATTENDANCE_ALERT",
]);
const MANDATORY = new Set(["ADMIN_ANNOUNCEMENT"]);

const PREFERENCES = TYPES.flatMap((notification_type) =>
  CHANNELS.map((channel) => ({
    notification_type,
    channel,
    enabled: true,
    digest: false,
    mandatory: MANDATORY.has(notification_type),
    digest_eligible: channel === "email" && DIGEST_ELIGIBLE.has(notification_type),
  })),
);

const getMock = mock((path: string) => {
  if (path === "/api/notification-preferences") {
    return Promise.resolve({
      data: { preferences: PREFERENCES, attendance_alert_threshold: 5 },
    });
  }
  return Promise.resolve({ data: undefined });
});

const patchMock = mock((_path: string, _options?: unknown) =>
  Promise.resolve({ data: { preferences: PREFERENCES, attendance_alert_threshold: 5 } }),
);

mock.module("../../lib/api", () => ({ api: { GET: getMock, PATCH: patchMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./NotificationPreferencesPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <Page />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  patchMock.mockClear();
});

describe("NotificationPreferencesPage", () => {
  test("shows every notification type with its channel toggles", async () => {
    renderPage(await loadPage());

    expect(await screen.findByText("Grade posted")).toBeTruthy();
    expect(screen.getByText("School announcement")).toBeTruthy();
  });

  test("a mandatory type's channel checkboxes are checked and locked", async () => {
    renderPage(await loadPage());

    await screen.findByText("School announcement");
    const inApp = screen.getByRole("checkbox", {
      name: "School announcement — In-app",
    }) as HTMLInputElement;

    expect(inApp.checked).toBe(true);
    expect(inApp.disabled).toBe(true);
    expect(screen.getByText("Mandatory")).toBeTruthy();
  });

  test("a digest-ineligible type's digest checkbox is disabled", async () => {
    renderPage(await loadPage());

    await screen.findByText("Grade posted");
    const digest = screen.getByRole("checkbox", {
      name: "Grade posted — daily digest",
    }) as HTMLInputElement;

    expect(digest.disabled).toBe(true);
  });

  test("a digest-eligible type's digest checkbox is enabled", async () => {
    renderPage(await loadPage());

    await screen.findByText("Discussion reply");
    const digest = screen.getByRole("checkbox", {
      name: "Discussion reply — daily digest",
    }) as HTMLInputElement;

    expect(digest.disabled).toBe(false);
  });

  test("toggling a channel and saving batches the change into one PATCH call", async () => {
    renderPage(await loadPage());

    await screen.findByText("Grade posted");
    const pushCheckbox = screen.getByRole("checkbox", {
      name: "Grade posted — Push",
    }) as HTMLInputElement;
    fireEvent.click(pushCheckbox);

    const saveButton = screen.getByRole("button", { name: "Save channel preferences" });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        "/api/notification-preferences",
        expect.objectContaining({
          body: {
            preferences: [{ notification_type: "GRADE_POSTED", channel: "push", enabled: false }],
          },
        }),
      );
    });
  });

  test("saving the attendance-alert threshold sends it on its own", async () => {
    renderPage(await loadPage());

    const input = await screen.findByLabelText("Personal absence threshold");
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save threshold" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        "/api/notification-preferences",
        expect.objectContaining({ body: { attendance_alert_threshold: 12 } }),
      );
    });
  });
});
