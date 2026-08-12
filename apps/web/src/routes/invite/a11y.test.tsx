import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";

import { InvitationOutcome } from "./InvitationOutcome";

import type { SessionStore } from "../../lib/auth";
import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the invitation activation flow (ST-180 AC: "a11y audit
 * passes"). Runs axe-core (the same engine and rule config `@studafy/ui`'s component tests use —
 * `lib/test/axe.ts`) against every structurally distinct state this flow can render: the shared
 * outcome card in both its shapes, the happy path with its two provider links, and both terminal
 * states of the completion page. The five verify-failure states all render through the same
 * `InvitationOutcome` markup with different text, so auditing its two shapes (with and without an
 * action link) covers all of them; repeating the audit five times over identical markup would test
 * axe five times, not the page.
 *
 * Rendered inside a `<main>`, matching how `RootLayout` actually wraps every route in production —
 * without it, axe's landmark rule would flag content that is never actually landmark-less.
 */

const getMock = mock((..._args: unknown[]) => Promise.resolve<unknown>({ data: undefined }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadInvitePage = async (): Promise<ComponentType> => (await import("./InvitePage")).default;
const loadInviteCompletePage = async (): Promise<ComponentType> =>
  (await import("./InviteCompletePage")).default;

function renderInMain(path: string, Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <main>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/invite/:token" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </main>
    </QueryClientProvider>,
  );
}

function pendingSessionStore(): SessionStore {
  return createSessionStore({
    refreshClient: {
      refresh: () => new Promise(() => undefined), // never resolves: pins the page in "restoring"
      logout: async () => undefined,
    },
  });
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("invite flow accessibility", () => {
  test("InvitationOutcome — minimal shape (no action, no request id)", async () => {
    const { container } = render(
      <main>
        <InvitationOutcome
          heading="This invitation has expired"
          message="Ask your school administrator for a new one."
        />
      </main>,
    );
    await expectNoA11yViolations(container);
  });

  test("InvitationOutcome — full shape (action link and request id)", async () => {
    const { container } = render(
      <main>
        <InvitationOutcome
          heading="We couldn't verify this invitation"
          message="Something went wrong on our end."
          action={{ label: "Sign in", href: "/auth/login" }}
          requestId="0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"
        />
      </main>,
    );
    await expectNoA11yViolations(container);
  });

  test("InvitePage — happy path with both provider links", async () => {
    getMock.mockImplementation(() =>
      Promise.resolve({
        data: { state: "valid", emailHint: "j***e@example.com", schoolName: "Example Academy" },
      }),
    );

    const Page = await loadInvitePage();
    const { container, findByRole } = renderInMain("/invite/tok-123", Page);
    await findByRole("link", { name: /continue with google/i });

    await expectNoA11yViolations(container);
  });

  test("InvitePage — loading state", async () => {
    getMock.mockImplementation(() => new Promise(() => undefined));

    const Page = await loadInvitePage();
    const { container, findByRole } = renderInMain("/invite/tok-123", Page);
    await findByRole("status");

    await expectNoA11yViolations(container);
  });

  test("InviteCompletePage — restoring (loading) state", async () => {
    const Page = await loadInviteCompletePage();
    const { container, findByRole } = render(
      <main>
        <AuthProvider store={pendingSessionStore()}>
          <MemoryRouter initialEntries={["/invite/tok-123/complete"]}>
            <Routes>
              <Route path="/invite/:token/complete" element={<Page />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </main>,
    );
    await findByRole("status");

    await expectNoA11yViolations(container);
  });

  test("InviteCompletePage — admin-approval outcome with a retry link", async () => {
    const Page = await loadInviteCompletePage();
    const { container, findByRole } = render(
      <main>
        <AuthProvider store={pendingSessionStore()}>
          <MemoryRouter
            initialEntries={["/invite/tok-123/complete?outcome=requires_admin_approval"]}
          >
            <Routes>
              <Route path="/invite/:token/complete" element={<Page />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </main>,
    );
    await findByRole("link", { name: /try a different account/i });

    await expectNoA11yViolations(container);
  });
});
