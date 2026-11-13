import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";

import InviteCompletePage from "./InviteCompletePage";

import type { SessionStore } from "../../lib/auth";

/** A minimal, valid-shaped unsigned JWT carrying the given roles in its payload. */
function fakeAccessToken(roles: string[]): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment({ roles })}.signature`;
}

function storeWithSession(roles: string[]): SessionStore {
  return createSessionStore({
    refreshClient: {
      refresh: async () => ({
        accessToken: fakeAccessToken(roles),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
}

function storeWithNoSession(): SessionStore {
  return createSessionStore({
    refreshClient: {
      refresh: async () => {
        throw { status: 400 };
      },
      logout: async () => undefined,
    },
  });
}

function renderAt(path: string, store: SessionStore) {
  return render(
    <AuthProvider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/invite/:token/complete" element={<InviteCompletePage />} />
          <Route path="/portal" element={<h1>Portal</h1>} />
          <Route path="/auth/login" element={<h1>Sign in</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(cleanup);

describe("InviteCompletePage", () => {
  test("recovers the freshly-set session and lands the user on their role home", async () => {
    renderAt("/invite/tok-123/complete", storeWithSession(["STUDENT"]));

    expect(
      await screen.findByRole("heading", { name: /portal/i, level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
  });

  test("renders the admin-approval outcome without touching the session store", async () => {
    renderAt(
      "/invite/tok-123/complete?outcome=requires_admin_approval",
      storeWithSession(["STUDENT"]),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/admin approval/i);
    const retry = screen.getByRole("link", { name: /try a different account/i });
    expect(retry.getAttribute("href")).toBe("/invite/tok-123");
  });

  test("falls back to sign-in if the redirect promised a session that isn't actually there", async () => {
    renderAt("/invite/tok-123/complete", storeWithNoSession());

    expect(
      await screen.findByRole("heading", { name: /sign in/i }, { timeout: 5000 }),
    ).toBeTruthy();
  });
});
