import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

const getMock = mock((_path: string) => Promise.resolve<unknown>({ data: { total: 0 } }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadDeps = async () => {
  const { AuthProvider } = await import("../../lib/auth");
  const { createSessionStore } = await import("../../lib/auth");
  const { PortalSidebar } = await import("./PortalSidebar");
  return { AuthProvider, createSessionStore, PortalSidebar };
};

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches access-token-claims.test.ts. */
function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderSidebarAs(roles: readonly string[]) {
  const { AuthProvider, createSessionStore, PortalSidebar } = await loadDeps();

  const store = createSessionStore({
    refreshClient: {
      refresh: async () => ({
        accessToken: fakeJwt({ roles }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider store={store}>
        <MemoryRouter>
          <PortalSidebar navId="portal-nav" open={false} />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

/** The exact, per-role visible menu — the "snapshot per role" this ticket's AC calls for. */
describe.each<[string, string[]]>([
  ["SUPER_ADMIN", ["Home", "Admin", "Principal", "Approvals", "Account"]],
  ["ORG_ADMIN", ["Home", "Admin", "Principal", "Approvals", "Account"]],
  ["INSTRUCTOR", ["Home", "Account"]],
  ["TEACHING_ASSISTANT", ["Home", "Account"]],
  ["STUDENT", ["Home", "Account"]],
  ["PARENT", ["Home", "Account"]],
  ["GUEST", ["Home", "Account"]],
  ["FINANCE", ["Home", "Account"]],
  ["SUPPORT_AGENT", ["Home", "Account"]],
])("PortalSidebar for %s", (role, expectedLabels) => {
  test(`renders exactly ${expectedLabels.join(", ")}`, async () => {
    await renderSidebarAs([role]);

    const nav = await screen.findByRole("navigation", { name: "Portal" });
    const links = within(nav).getAllByRole("link");

    expect(links.map((link) => link.textContent)).toEqual(expectedLabels);
  });
});

describe("PortalSidebar", () => {
  test("marks the item matching the current route as the current page", async () => {
    const { AuthProvider, createSessionStore, PortalSidebar } = await loadDeps();
    const store = createSessionStore({
      refreshClient: {
        refresh: async () => ({
          accessToken: fakeJwt({ roles: ["STUDENT"] }),
          expiresAt: Date.now() + 3_600_000,
          sessionId: "session-1",
        }),
        logout: async () => undefined,
      },
    });
    await store.restore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider store={store}>
          <MemoryRouter initialEntries={["/portal"]}>
            <PortalSidebar navId="portal-nav" open={false} />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    const home = await screen.findByRole("link", { name: "Home" });
    expect(home.getAttribute("aria-current")).toBe("page");

    const account = screen.getByRole("link", { name: "Account" });
    expect(account.getAttribute("aria-current")).toBeNull();
  });
});
