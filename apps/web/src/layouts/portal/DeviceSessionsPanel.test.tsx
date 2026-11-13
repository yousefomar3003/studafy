import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../lib/test/axe";

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

// Only ../../lib/api is stubbed — never ../../lib/auth wholesale, which would replace the module
// for every test file sharing this bun test process (see git history: "drop mock.module from oauth
// callback tests that leaked across CI test files"). A real AuthProvider + session store instead.
mock.module("../../lib/api", () => ({ api: { GET: getMock, DELETE: deleteMock } }));

const loadPanel = async () => {
  const { AuthProvider, createSessionStore } = await import("../../lib/auth");
  const { DeviceSessionsPanel } = await import("./DeviceSessionsPanel");
  return { AuthProvider, createSessionStore, DeviceSessionsPanel };
};

async function renderPanel() {
  const { AuthProvider, createSessionStore, DeviceSessionsPanel } = await loadPanel();

  // `sessionId: "session-current"` matches the id of the session in the mocked list above, so the
  // panel can identify "this session" the same way it would from a real token.
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
      <AuthProvider store={store}>
        <DeviceSessionsPanel open onClose={() => undefined} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  deleteMock.mockClear();
});

describe("DeviceSessionsPanel", () => {
  test("lists sessions and marks the caller's own session as current, not revocable", async () => {
    await renderPanel();

    expect(await screen.findByText("Chrome on macOS")).toBeTruthy();
    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("Safari on iPhone")).toBeTruthy();

    // Exactly one revoke button: the current session has no revoke action.
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  test("lists registered devices with an active session count", async () => {
    await renderPanel();

    expect(await screen.findByText("iOS")).toBeTruthy();
    expect(screen.getByText("1 active session")).toBeTruthy();
  });

  test("revoking a session calls the session DELETE endpoint", async () => {
    await renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith(
        "/api/auth/sessions/{sessionId}",
        expect.objectContaining({ params: { path: { sessionId: "session-other" } } }),
      );
    });
  });

  test("removing a device calls the device DELETE endpoint", async () => {
    await renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Remove device" }));

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith(
        "/api/auth/devices/{deviceId}",
        expect.objectContaining({ params: { path: { deviceId: "device-2" } } }),
      );
    });
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPanel();
    await screen.findByText("Chrome on macOS");

    await expectNoA11yViolations(container);
  });
});
