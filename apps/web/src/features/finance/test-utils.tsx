import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../../lib/auth";
import { createTestSessionStore } from "../../lib/test/session";

import type { ReactElement } from "react";

/**
 * Renders a finance screen the way the portal does: signed in with `roles` (the session user is
 * `user-1`), React Query, toasts, and a router at `path`, matched by `routePath` so `useParams`
 * works. Any other path renders "navigated", so a test can see that a `navigate` left the page.
 */
export async function renderFinance(
  element: ReactElement,
  {
    roles = ["FINANCE"],
    path = "/",
    routePath = "*",
  }: { roles?: readonly string[]; path?: string; routePath?: string } = {},
) {
  const store = await createTestSessionStore(roles);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={routePath} element={element} />
              {routePath === "*" ? null : <Route path="*" element={<p>navigated</p>} />}
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

/** The init (params/body) of the first call to `path` on a bun mock, or undefined. */
export function callTo(
  calls: readonly unknown[][],
  path: string,
):
  | { params?: { path?: Record<string, string>; query?: Record<string, unknown> }; body?: unknown }
  | undefined {
  const call = calls.find((args) => args[0] === path);
  return call?.[1] as never;
}
