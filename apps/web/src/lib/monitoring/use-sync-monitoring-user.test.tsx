import { act, cleanup, render } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AuthProvider, createSessionStore } from "../auth";

import { useSyncMonitoringUser } from "./use-sync-monitoring-user";

function fakeAccessToken(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub, roles: [] })).toString("base64url");
  return `header.${payload}.signature`;
}

function Probe({ setUser }: { setUser: (userId: string | null) => void }) {
  useSyncMonitoringUser(setUser);
  return null;
}

afterEach(cleanup);

describe("useSyncMonitoringUser", () => {
  test("sets the Sentry user to the session's own id once authenticated", async () => {
    const store = createSessionStore({
      refreshClient: {
        refresh: async () => ({
          accessToken: fakeAccessToken("user-1"),
          expiresAt: Date.now() + 3_600_000,
          sessionId: "session-1",
        }),
        logout: async () => undefined,
      },
    });
    await store.restore();
    const setUser = mock();

    render(
      <AuthProvider store={store}>
        <Probe setUser={setUser} />
      </AuthProvider>,
    );

    expect(setUser).toHaveBeenLastCalledWith("user-1");
  });

  test("clears the Sentry user once signed out", async () => {
    const store = createSessionStore({
      refreshClient: {
        refresh: async () => ({
          accessToken: fakeAccessToken("user-2"),
          expiresAt: Date.now() + 3_600_000,
          sessionId: "session-2",
        }),
        logout: async () => undefined,
      },
    });
    await store.restore();
    const setUser = mock();

    render(
      <AuthProvider store={store}>
        <Probe setUser={setUser} />
      </AuthProvider>,
    );
    expect(setUser).toHaveBeenLastCalledWith("user-2");

    await act(() => store.logout());

    expect(setUser).toHaveBeenLastCalledWith(null);
  });

  test("calls setUser with null before any session has been restored", () => {
    const store = createSessionStore({
      refreshClient: {
        refresh: () => Promise.reject(Object.assign(new Error("no cookie"), { status: 400 })),
        logout: async () => undefined,
      },
    });
    const setUser = mock();

    render(
      <AuthProvider store={store}>
        <Probe setUser={setUser} />
      </AuthProvider>,
    );

    expect(setUser).toHaveBeenLastCalledWith(null);
  });
});
