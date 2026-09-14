import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../../lib/test/axe";

const getMock = mock((path: string) => {
  if (path === "/api/auth/sessions") {
    return Promise.resolve({
      data: {
        sessions: [
          {
            id: "session-current",
            device_id: "device-1",
            device_name: "Chrome on macOS",
            channel: "web",
            user_agent: "ua",
            ip_address: "203.0.113.5",
            issued_at: "2026-08-10T09:00:00.000Z",
            expires_at: "2026-08-10T09:15:00.000Z",
          },
          {
            id: "session-other",
            device_id: "device-2",
            device_name: "Safari on iPhone",
            channel: "mobile",
            user_agent: "ua-2",
            ip_address: "203.0.113.9",
            issued_at: "2026-08-09T09:00:00.000Z",
            expires_at: "2026-08-09T09:15:00.000Z",
          },
        ],
      },
    });
  }
  return Promise.resolve({
    data: {
      devices: [
        {
          id: "device-1",
          platform: "macOS",
          last_seen: "2026-08-10T09:00:00.000Z",
          created_at: "2026-08-01T09:00:00.000Z",
          active_session_count: 1,
        },
        {
          id: "device-2",
          platform: "iOS",
          last_seen: "2026-08-09T09:00:00.000Z",
          created_at: "2026-08-01T09:00:00.000Z",
          active_session_count: 1,
        },
      ],
    },
  });
});

const deleteMock = mock((_path: string) =>
  Promise.resolve({ data: { revoked: 1, denylisted: 1 } }),
);

const postMock = mock((_path: string) => Promise.resolve({ data: { revoked: 1, denylisted: 1 } }));

// Only ../../../lib/api is stubbed — never ../../../lib/auth wholesale, which would replace the
// module for every test file sharing this bun test process (see git history: "drop mock.module from
// oauth callback tests that leaked across CI test files"). A real AuthProvider + session store
// instead, the way DeviceSessionsPanel.test.tsx does.
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, DELETE: deleteMock, POST: postMock },
}));

const loadPage = async () => {
  const { AuthProvider, createSessionStore } = await import("../../../lib/auth");
  const { default: SessionsPage } = await import("./SessionsPage");
  return { AuthProvider, createSessionStore, SessionsPage };
};

async function renderPage() {
  const { AuthProvider, createSessionStore, SessionsPage: Page } = await loadPage();

  // `sessionId: "session-current"` matches the id of the session in the mocked list above, so the
  // page can identify "this session" and, through its `device_id`, "this device" the same way it
  // would from a real token.
  const store = createSessionStore({
    refreshClient: {
      refresh: async () => ({
        accessToken: "at-1",
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-current",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider store={store}>
          <Page />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  deleteMock.mockClear();
  postMock.mockClear();
});

describe("SessionsPage", () => {
  test("lists sessions and devices, marking the current session and current device", async () => {
    await renderPage();

    expect(await screen.findByText("Chrome on macOS")).toBeTruthy();
    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("Safari on iPhone")).toBeTruthy();
    expect(screen.getByText("iOS")).toBeTruthy();

    // device-1 is the device the current session carries — marked, not removable via its own entry.
    expect(screen.getByText("This device")).toBeTruthy();

    // Exactly one revoke button: the current session has no revoke action.
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  test("revoking a session calls the session DELETE endpoint", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith(
        "/api/auth/sessions/{sessionId}",
        expect.objectContaining({ params: { path: { sessionId: "session-other" } } }),
      );
    });
  });

  test("removing a device asks for confirmation, and cancelling does nothing", async () => {
    await renderPage();

    // device-1 is the current device; device-2 is the other one. Two "Remove device" row buttons.
    const removeButtons = await screen.findAllByRole("button", { name: "Remove device" });
    expect(removeButtons.length).toBeGreaterThan(0);

    fireEvent.click(removeButtons[0]);
    expect(await screen.findByText("Remove this device?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test("confirming device removal calls the device DELETE endpoint", async () => {
    await renderPage();

    // device-1 (current) then device-2 (iOS) render in DOM order; the action we're proving ends
    // the other device's sessions, so press the second row's button.
    const removeButtons = await screen.findAllByRole("button", { name: "Remove device" });
    fireEvent.click(removeButtons[1]);

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith(
        "/api/auth/devices/{deviceId}",
        expect.objectContaining({ params: { path: { deviceId: "device-2" } } }),
      );
    });
  });

  test("signing out elsewhere asks for confirmation and posts to revoke-others", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Sign out elsewhere" }));

    // The dialog's confirm button shares its label with the header trigger, so scope the click to
    // the open dialog rather than the page behind it.
    const dialog = await screen.findByRole("dialog", { name: "Sign out of all other devices?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out elsewhere" }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/api/auth/sessions/revoke-others",
        expect.objectContaining({ body: undefined }),
      );
    });
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPage();
    await screen.findByText("Chrome on macOS");

    await expectNoA11yViolations(container);
  });
});
