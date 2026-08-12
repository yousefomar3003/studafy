import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { createSessionStore } from "../lib/auth";

import { AppProviders, createInertRealtimeSocket } from "./providers";
import { routes } from "./routes";

// These tests assert routing, not data. Stub the API client so the /portal page's health query
// resolves in-memory instead of reaching for a server that is not running under the test.
mock.module("../lib/api", () => ({
  api: { GET: () => Promise.resolve({ data: { status: "ok" } }) },
}));

afterEach(cleanup);

// /portal and /account are behind <RequireAuth>, so every render needs an authenticated session.
// Build a store over an in-memory refresh client and resolve it before the page mounts.
const sessionStore = createSessionStore({
  refreshClient: {
    refresh: async () => ({
      accessToken: "test-token",
      expiresAt: Date.now() + 3_600_000,
      sessionId: "test-session",
    }),
    logout: async () => undefined,
  },
});
await sessionStore.restore();

const renderAt = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  // Wrap in the real app providers: pages such as /portal now consume the API client via a query,
  // which needs the QueryClientProvider, and the route guards need the AuthProvider.
  return render(
    <AppProviders sessionStore={sessionStore} realtimeSocketFactory={createInertRealtimeSocket}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
};

describe("app shell", () => {
  test("renders the shared shell and marketing home at /", async () => {
    renderAt("/");
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: /studafy/i, level: 1 })).toBeTruthy();
  });

  test("resolves the lazy /portal route group", async () => {
    renderAt("/portal");
    expect(
      await screen.findByRole("heading", { name: /portal/i, level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
  });

  test("resolves the lazy /account route group", async () => {
    renderAt("/account");
    expect(await screen.findByRole("heading", { name: /account/i, level: 1 })).toBeTruthy();
  });
});
