import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { clearReturnTo, createSessionStore, getReturnTo } from "../lib/auth";

import { AppProviders, createInertRealtimeSocket } from "./providers";
import { routes } from "./routes";

import type { SessionStore } from "../lib/auth";

// These tests assert the web auth flow (guard -> login -> OAuth callback -> return-to), not data.
// Stub the API client so pages that issue a query resolve in-memory.
mock.module("../lib/api", () => ({
  api: { GET: () => Promise.resolve({ data: { status: "ok" } }) },
}));

/**
 * A session store whose refresh client can flip between "no cookie" and "live cookie" mid-test, so
 * a single suite can exercise the signed-out deep link, the expired-session hop, and the sign-in
 * recovery without touching the network. The store's `restore()` always re-rotates (never caches),
 * so flipping the flag takes effect on the next guard/callback entry.
 */
function createStore(): {
  store: SessionStore;
  setHasSession(has: boolean): void;
  setExpired(): void;
} {
  let hasSession = false;
  let expired = false;
  const store = createSessionStore({
    refreshClient: {
      refresh: async () => {
        if (expired) {
          throw { status: 401 };
        }
        if (!hasSession) {
          throw { status: 400 };
        }
        return { accessToken: "test-token", expiresAt: Date.now() + 3_600_000, sessionId: "s" };
      },
      logout: async () => undefined,
    },
  });
  return {
    store,
    setHasSession: (v) => {
      hasSession = v;
    },
    setExpired: () => {
      expired = true;
    },
  };
}

const renderAt = (path: string, store: SessionStore) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(
    <AppProviders sessionStore={store} realtimeSocketFactory={createInertRealtimeSocket}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, router };
};

afterEach(cleanup);
beforeEach(() => clearReturnTo());

describe("web auth flow", () => {
  test("a signed-out deep link is redirected to login and the route is saved for later", async () => {
    renderAt("/account", createStore().store);

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeTruthy();
    expect(getReturnTo()).toBe("/account");
  });

  test("a dead session is sent to login with the expired-session notice", async () => {
    const { store, setExpired } = createStore();
    setExpired();
    renderAt("/account", store);

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeTruthy();
    expect(screen.getByText(/session expired/i)).toBeTruthy();
  });

  test("the OAuth callback restores the saved route after sign-in", async () => {
    const { store, setHasSession } = createStore();

    // Signed-out deep link: the guard saves the route and lands on the login page.
    renderAt("/account", store);
    await screen.findByRole("heading", { name: /sign in/i });

    // The OAuth round trip completes and the API bounces the browser here with the cookie set.
    cleanup();
    setHasSession(true);
    const { router } = renderAt("/auth/callback", store);

    expect(
      await screen.findByRole("heading", { name: /account/i, level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(getReturnTo()).toBeNull();

    // The callback is replaced, never pushed: the landing URL carries no query string or fragment,
    // so no authorization code, state, or token ever sits in the address bar or survives in history.
    expect(router.state.location.pathname).toBe("/account");
    expect(router.state.location.search).toBe("");
    expect(router.state.location.hash).toBe("");
  });

  test("the login page recovers a still-live session instead of showing provider buttons", async () => {
    const { store, setHasSession } = createStore();
    setHasSession(true);

    renderAt("/auth/login", store);

    expect(
      await screen.findByRole("heading", { name: /portal/i, level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
  });
});
