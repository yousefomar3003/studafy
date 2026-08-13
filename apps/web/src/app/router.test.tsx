import { cleanup, render, screen, within } from "@testing-library/react";
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

  test("resolves the lazy /features route", async () => {
    renderAt("/features");
    expect(
      await screen.findByRole(
        "heading",
        { name: /whole school day/i, level: 1 },
        { timeout: 5000 },
      ),
    ).toBeTruthy();
  });

  test("resolves the lazy /pricing route", async () => {
    renderAt("/pricing");
    expect(
      await screen.findByRole("heading", { name: /pricing/i, level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
  });

  test("resolves the lazy /about route", async () => {
    renderAt("/about");
    expect(
      await screen.findByRole("heading", { name: /about studafy/i, level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
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

  test("resolves the lazy /invite/:token route, publicly (no RequireAuth redirect)", async () => {
    renderAt("/invite/tok-123");
    expect(
      await screen.findByRole("heading", { name: /invited/i, level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
  });

  test("resolves the lazy /invite/:token/complete route and forwards an authenticated session home", async () => {
    renderAt("/invite/tok-123/complete");
    expect(
      await screen.findByRole("heading", { name: /portal/i, level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
  });

  test("the portal shell renders the permission-gated sidebar for a roleless session", async () => {
    renderAt("/portal");

    const nav = await screen.findByRole("navigation", { name: "Portal" }, { timeout: 5000 });
    // This suite's shared store carries no roles (a non-JWT "test-token"), so only the
    // unconditional items render — Approvals (gated on approval:review) does not.
    expect(within(nav).getByRole("link", { name: "Home" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Account" })).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: "Approvals" })).toBeNull();
  });

  test("a session without approval:review is redirected off /portal/approvals with a notice", async () => {
    renderAt("/portal/approvals");

    expect(
      await screen.findByRole("heading", { name: /portal/i, level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches access-token-claims.test.ts. */
function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

describe("app shell for a session holding approval:review", () => {
  test("reaches /portal/approvals directly, and the sidebar shows the gated item", async () => {
    const orgAdminStore = createSessionStore({
      refreshClient: {
        refresh: async () => ({
          accessToken: fakeJwt({ roles: ["ORG_ADMIN"] }),
          expiresAt: Date.now() + 3_600_000,
          sessionId: "org-admin-session",
        }),
        logout: async () => undefined,
      },
    });
    await orgAdminStore.restore();

    const router = createMemoryRouter(routes, { initialEntries: ["/portal/approvals"] });
    render(
      <AppProviders sessionStore={orgAdminStore} realtimeSocketFactory={createInertRealtimeSocket}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    expect(
      await screen.findByRole("heading", { name: /approvals/i, level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    const nav = await screen.findByRole("navigation", { name: "Portal" });
    expect(within(nav).getByRole("link", { name: "Approvals" })).toBeTruthy();
  });
});
