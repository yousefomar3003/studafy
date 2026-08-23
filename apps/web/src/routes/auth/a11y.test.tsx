import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../lib/test/axe";

/**
 * Automated accessibility audit for the sign-in entry point — previously untested for a11y. Both
 * states LoginPage itself renders: the plain sign-in prompt, and the same prompt with the
 * `?reason=expired` status message an expired-session redirect adds.
 */

async function renderLoginAt(path: string) {
  const { AuthProvider, createSessionStore } = await import("../../lib/auth");
  const LoginPage = (await import("./LoginPage")).default;

  const store = createSessionStore({
    refreshClient: {
      // No live refresh cookie: resolves to the unauthenticated state, which is what shows the
      // sign-in buttons this page exists for.
      refresh: async () => {
        throw new Error("no session");
      },
      logout: async () => undefined,
    },
  });
  await store.restore().catch(() => undefined);

  return render(
    <AuthProvider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/auth/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(cleanup);

describe("login page accessibility", () => {
  test("plain sign-in prompt", async () => {
    const { container } = await renderLoginAt("/auth/login");
    await screen.findByRole("heading", { name: "Sign in" });

    await expectNoA11yViolations(container);
  });

  test("expired-session prompt", async () => {
    const { container } = await renderLoginAt("/auth/login?reason=expired");
    await screen.findByRole("status");

    await expectNoA11yViolations(container);
  });
});
