import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";

import type { SessionTokens } from "../../lib/auth";
import type { ComponentType } from "react";

function makeOverview(overrides: Record<string, unknown> = {}) {
  return {
    subscription: {
      id: "sub-1",
      status: "active",
      currentPeriodStart: "2026-08-01T00:00:00.000Z",
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      cancellationRequestedAt: null,
      cancellationReason: null,
      retentionState: "none",
      ...(overrides.subscription as Record<string, unknown> | undefined),
    },
    plan: { id: "plan-1", code: "growth", displayName: "Studafy Growth" },
    seats: { used: 7, cap: 20 },
    storage: { usedBytes: 524_288_000, capBytes: 1_048_576_000, fractionUsed: 0.5 },
    ...overrides,
  };
}

let currentOverview = makeOverview();

const getMock = mock((path: string) => {
  if (path === "/api/subscriptions/current") {
    return Promise.resolve({ data: currentOverview });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string) => {
  if (path === "/api/subscriptions/portal") {
    return Promise.resolve({ data: { url: "https://billing.example.com/portal" } });
  }
  if (path === "/api/subscriptions/current/cancel") {
    return Promise.resolve({
      data: {
        id: "sub-1",
        status: "active",
        cancelAtPeriodEnd: true,
        cancellationRequestedAt: "2026-08-22T00:00:00.000Z",
        cancellationReason: "Too expensive",
        retentionState: "none",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      },
    });
  }
  if (path === "/api/subscriptions/current/cancel/reverse") {
    return Promise.resolve({
      data: {
        id: "sub-1",
        status: "active",
        cancelAtPeriodEnd: false,
        cancellationRequestedAt: null,
        cancellationReason: null,
        retentionState: "retained",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      },
    });
  }
  return Promise.resolve({ data: undefined });
});

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

// `useOpenBillingPortal`/`useStartSchoolCheckout` redirect via `window.location.assign` on success —
// stubbed the same way `useOAuthLogin`'s own `window.location.assign` redirect is left untested
// elsewhere in this app, rather than letting happy-dom attempt a real navigation.
const assignMock = mock((_url: string) => undefined);
window.location.assign = assignMock;

const loadPage = async (): Promise<ComponentType> =>
  (await import("./BillingOverviewPage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderPage(Page: ComponentType) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: ["ORG_ADMIN"], sub: "user-current" }),
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
          <MemoryRouter>
            <Page />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  assignMock.mockClear();
  currentOverview = makeOverview();
});

describe("BillingOverviewPage", () => {
  test("renders the active plan, seat usage, and current period", async () => {
    await renderPage(await loadPage());

    await screen.findByText("Studafy Growth");
    expect(screen.getByText("7/20")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  test("shows the past-due dunning banner and opens the payment provider portal", async () => {
    currentOverview = makeOverview({ subscription: { status: "past_due" } });
    await renderPage(await loadPage());

    await screen.findByText("Your last payment failed");

    fireEvent.click(screen.getByRole("button", { name: "Update payment method" }));

    await screen.findByText("Studafy Growth");
    expect(postMock).toHaveBeenCalledWith(
      "/api/subscriptions/portal",
      expect.objectContaining({ body: expect.objectContaining({ returnUrl: expect.any(String) }) }),
    );
    expect(assignMock).toHaveBeenCalledWith("https://billing.example.com/portal");
  });

  test("shows the grace-period dunning banner naming the deadline", async () => {
    currentOverview = makeOverview({ subscription: { status: "grace_period" } });
    await renderPage(await loadPage());

    await screen.findByText("Your subscription is in a grace period");
  });

  test("shows a plan-picker prompt once the subscription has ended, and hides cancel controls", async () => {
    currentOverview = makeOverview({ subscription: { status: "canceled" } });
    await renderPage(await loadPage());

    await screen.findByText("Your subscription has ended");
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).toBeNull();
  });

  test("cancelling schedules the cancellation with the entered reason", async () => {
    await renderPage(await loadPage());

    await screen.findByText("Studafy Growth");
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));

    const dialog = await screen.findByRole("dialog", { name: "Cancel subscription?" });
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: "Too expensive" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel subscription" }));

    expect(await screen.findByText("Cancellation scheduled")).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith(
      "/api/subscriptions/current/cancel",
      expect.objectContaining({ body: { reason: "Too expensive" } }),
    );
  });

  test("a subscription with a pending cancellation offers to undo it instead", async () => {
    currentOverview = makeOverview({
      subscription: {
        cancelAtPeriodEnd: true,
        cancellationRequestedAt: "2026-08-20T00:00:00.000Z",
      },
    });
    await renderPage(await loadPage());

    await screen.findByText(/Cancellation scheduled/);
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Keep subscription" }));

    expect(await screen.findByText("Cancellation undone")).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith("/api/subscriptions/current/cancel/reverse");
  });
});
