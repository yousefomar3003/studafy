import { PERMISSIONS } from "@studafy/constants";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { AuthProvider } from "./context";
import { RequirePermission } from "./require-permission";
import { createSessionStore } from "./session-store";

import type { SessionTokens } from "./session-store";

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches access-token-claims.test.ts. */
function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderProtectedAt(roles: readonly string[], initialPath: string) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();

  const router = createMemoryRouter(
    [
      {
        path: "/protected",
        element: (
          <RequirePermission permission={PERMISSIONS.APPROVAL_REVIEW}>
            <p>Protected content</p>
          </RequirePermission>
        ),
      },
      { path: "/portal", element: <p>Portal home</p> },
    ],
    { initialEntries: [initialPath] },
  );

  return render(
    <AuthProvider store={store}>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
}

afterEach(cleanup);

describe("RequirePermission", () => {
  test("renders children when the session holds the required permission", async () => {
    await renderProtectedAt(["ORG_ADMIN"], "/protected");

    expect(await screen.findByText("Protected content")).toBeTruthy();
  });

  test("redirects to the fallback with a forbidden notice when the permission is missing", async () => {
    await renderProtectedAt(["STUDENT"], "/protected");

    expect(await screen.findByText("Portal home")).toBeTruthy();
    expect(screen.queryByText("Protected content")).toBeNull();
  });
});
