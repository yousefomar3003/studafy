import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";

import { MarketingHeader } from "./MarketingHeader";

import type { SessionTokens } from "../../lib/auth";

const HINT_KEY = "studafy.auth.signed-in";

function renderHeader(refresh: () => Promise<SessionTokens>) {
  const refreshMock = mock(refresh);
  const store = createSessionStore({
    refreshClient: { refresh: refreshMock, logout: () => Promise.resolve() },
  });
  render(
    <AuthProvider store={store}>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <MarketingHeader navId="marketing-nav" navOpen={false} onToggleNav={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
  return { refreshMock, store };
}

beforeEach(() => localStorage.removeItem(HINT_KEY));
afterEach(() => {
  cleanup();
  localStorage.removeItem(HINT_KEY);
});

describe("MarketingHeader", () => {
  test("the brand links home", () => {
    renderHeader(() => Promise.reject(new Error("no session")));
    expect(screen.getByRole("link", { name: "Studafy" }).getAttribute("href")).toBe("/");
  });

  test("an anonymous visitor sees Sign in, and the refresh endpoint is never called", () => {
    const { refreshMock } = renderHeader(() => Promise.reject(new Error("no session")));

    expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("a browser that was signed in restores the session and shows the account menu", async () => {
    localStorage.setItem(HINT_KEY, "1");
    renderHeader(() =>
      Promise.resolve({
        accessToken: "at-1",
        expiresAt: Date.now() + 15 * 60_000,
        sessionId: "session-1",
      }),
    );

    const menu = await screen.findByRole("button", { name: "Account menu" });
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();

    fireEvent.click(menu);
    expect(screen.getByRole("link", { name: "Go to portal" }).getAttribute("href")).toBe("/portal");
  });

  test("a stale hint falls back to Sign in and is cleared", async () => {
    localStorage.setItem(HINT_KEY, "1");
    renderHeader(() => Promise.reject(Object.assign(new Error("no cookie"), { status: 400 })));

    await waitFor(() => expect(localStorage.getItem(HINT_KEY)).toBeNull());
    expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
  });
});
