import { ApiError } from "@studafy/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { ComponentType } from "react";

// Mock the app client before InvitePage is loaded, so the verify query hits this stub instead of
// the network. InvitePage is imported dynamically in each test, after the mock is registered.
const getMock = mock((..._args: unknown[]) => Promise.resolve<unknown>({ data: undefined }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadInvitePage = async (): Promise<ComponentType> => (await import("./InvitePage")).default;

function renderAt(path: string, Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/invite/:token" element={<Page />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function problem(status: number, code: string, requestId = "req-1") {
  return new ApiError({
    status,
    title: code,
    code: code as never,
    detail: null,
    instance: null,
    type: null,
    request_id: requestId,
    problem: null,
  });
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("InvitePage", () => {
  test("renders the happy path with both provider buttons once the token verifies", async () => {
    getMock.mockImplementation(() =>
      Promise.resolve({
        data: { state: "valid", emailHint: "j***e@example.com", schoolName: "Example Academy" },
      }),
    );

    renderAt("/invite/tok-123", await loadInvitePage());

    expect(await screen.findByText(/example academy/i)).toBeTruthy();
    expect(screen.getByText(/j\*\*\*e@example\.com/)).toBeTruthy();
    const google = screen.getByRole("link", { name: /continue with google/i });
    const microsoft = screen.getByRole("link", { name: /continue with microsoft/i });
    expect(google.getAttribute("href")).toContain(
      "/api/auth/invitations/tok-123/oauth/google/start",
    );
    expect(microsoft.getAttribute("href")).toContain(
      "/api/auth/invitations/tok-123/oauth/microsoft/start",
    );
  });

  test.each([
    ["EXPIRED", /expired/i],
    ["REVOKED", /revoked/i],
    ["CONSUMED", /already used/i],
    ["SCHOOL_SUSPENDED", /suspended/i],
    ["INVITATION_INVALID", /isn't valid/i],
  ])("renders distinct, actionable copy for %s", async (code, expectedHeading) => {
    getMock.mockImplementation(() =>
      Promise.reject(problem(code === "INVITATION_INVALID" ? 400 : 409, code)),
    );

    renderAt("/invite/tok-123", await loadInvitePage());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(expectedHeading);
  });

  test("the consumed state offers a sign-in link instead of a retry", async () => {
    getMock.mockImplementation(() => Promise.reject(problem(409, "CONSUMED")));

    renderAt("/invite/tok-123", await loadInvitePage());

    const link = await screen.findByRole("link", { name: /sign in/i });
    expect(link.getAttribute("href")).toBe("/auth/login");
  });

  test("an unrecognized error code still renders a generic, actionable alert", async () => {
    getMock.mockImplementation(() => Promise.reject(problem(500, "INTERNAL_ERROR", "req-9")));

    renderAt("/invite/tok-123", await loadInvitePage());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't verify/i);
    expect(alert.textContent).toMatch(/req-9/);
  });
});
