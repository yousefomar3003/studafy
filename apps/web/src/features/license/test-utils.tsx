import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";

import type { SessionTokens } from "../../lib/auth";
import type { ReactElement } from "react";

/** A JWT-shaped, unsigned token carrying `roles` (as in the principal pages' tests). */
function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

/**
 * Render a license page for a session holding `role` -- PRINCIPAL holds license:read and
 * license:manage; FINANCE holds neither, which stands in for a read-only session (the route itself
 * is gated on license:read).
 */
export async function renderAs(
  role: string,
  page: ReactElement,
  { path = "/", at = path }: { path?: string; at?: string } = {},
) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: [role] }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[at]}>
            <Routes>
              <Route path={path} element={page} />
              <Route path="*" element={<p>Navigated away</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}
