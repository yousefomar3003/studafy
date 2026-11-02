import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { expectNoA11yViolations } from "../../lib/test/axe";

const getMock = mock((_path: string) => Promise.resolve({ data: { sessions: [], devices: [] } }));
mock.module("../../lib/api", () => ({ api: { GET: getMock, DELETE: getMock } }));

const loadUserMenu = async () => {
  const { AuthProvider, createSessionStore } = await import("../../lib/auth");
  const { UserMenu } = await import("./UserMenu");
  return { AuthProvider, createSessionStore, UserMenu };
};

async function renderMenu(logoutSpy: () => Promise<void>) {
  const { AuthProvider, createSessionStore, UserMenu } = await loadUserMenu();

  const store = createSessionStore({
    refreshClient: {
      refresh: async () => ({
        accessToken: "at-1",
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: logoutSpy,
    },
  });
  await store.restore();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider store={store}>
        <MemoryRouter>
          <UserMenu />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("UserMenu", () => {
  test("opens the panel on click, closed by default", async () => {
    await renderMenu(async () => undefined);

    const trigger = screen.getByRole("button", { name: "Account menu" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Sign out")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Sign out")).toBeTruthy();
  });

  test("opening devices & sessions closes the menu and shows the panel dialog", async () => {
    await renderMenu(async () => undefined);

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByText("Devices & sessions"));

    expect(screen.queryByText("Sign out")).toBeNull();
    expect(await screen.findByRole("dialog", { name: "Devices & sessions" })).toBeTruthy();
  });

  test("sign out calls the session store's logout", async () => {
    let called = false;
    await renderMenu(async () => {
      called = true;
    });

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByText("Sign out"));

    await waitFor(() => expect(called).toBe(true));
  });

  test("has no accessibility violations with the panel and the devices dialog open", async () => {
    const { container } = await renderMenu(async () => undefined);

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByText("Devices & sessions"));
    await screen.findByRole("dialog", { name: "Devices & sessions" });
    await expectNoA11yViolations(container);
  });
});
