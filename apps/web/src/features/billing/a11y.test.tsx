import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";

import type { SessionTokens } from "../../lib/auth";
import type { ComponentType } from "react";

/** Automated accessibility audit for the billing screens, mirroring
 * `finance/adjustments/a11y.test.tsx`. */

const OVERVIEW = {
  subscription: {
    id: "sub-1",
    status: "past_due",
    currentPeriodStart: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    cancellationRequestedAt: null,
    cancellationReason: null,
    retentionState: "none",
  },
  plan: { id: "plan-1", code: "growth", displayName: "Studafy Growth" },
  seats: { used: 7, cap: 20 },
  storage: { usedBytes: 524_288_000, capBytes: 1_048_576_000, fractionUsed: 0.5 },
};

const PLANS = [
  {
    id: "plan-1",
    code: "growth",
    displayName: "Studafy Growth",
    description: "Up to 500 students",
    prices: [
      {
        id: "price-1",
        currencyCode: "USD",
        billingInterval: "monthly",
        amountMinor: 4900,
        stripePriceId: "price_1",
      },
    ],
  },
  {
    id: "plan-2",
    code: "scale",
    displayName: "Studafy Scale",
    description: "Up to 2000 students",
    prices: [
      {
        id: "price-2",
        currencyCode: "USD",
        billingInterval: "monthly",
        amountMinor: 9900,
        stripePriceId: "price_2",
      },
    ],
  },
];

const INVOICE = {
  id: "in_1",
  status: "paid",
  amountDue: 4900,
  amountPaid: 4900,
  currency: "USD",
  created: "2026-08-01T00:00:00.000Z",
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  hostedInvoiceUrl: "https://invoice.example.com/in_1",
  invoicePdf: "https://invoice.example.com/in_1.pdf",
};

const getMock = mock((path: string) => {
  if (path === "/api/subscriptions/current") {
    return Promise.resolve({ data: OVERVIEW });
  }
  if (path === "/api/subscriptions/plans") {
    return Promise.resolve({ data: PLANS });
  }
  if (path === "/api/subscriptions/current/invoices") {
    return Promise.resolve({ data: { invoices: [INVOICE], hasMore: false } });
  }
  return Promise.resolve({ data: undefined });
});
mock.module("../../lib/api", () => ({
  api: { GET: getMock, POST: mock(() => Promise.resolve({ data: undefined })) },
}));

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderInPortal(Page: ComponentType, initialPath: string, routePath: string) {
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
          <MemoryRouter initialEntries={[initialPath]}>
            <main>
              <Routes>
                <Route path={routePath} element={<Page />} />
              </Routes>
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("billing screens accessibility", () => {
  test("billing overview, populated with a past-due dunning banner", async () => {
    const Page = (await import("./BillingOverviewPage")).default;
    const { container } = await renderInPortal(Page, "/portal/billing", "/portal/billing");
    await screen.findByRole("heading", { name: "Billing" });
    await screen.findByText("Your last payment failed");

    await expectNoA11yViolations(container);
  });

  test("change-plan dialog, open with the plan picker populated", async () => {
    const Page = (await import("./BillingOverviewPage")).default;
    const { container } = await renderInPortal(Page, "/portal/billing", "/portal/billing");
    await screen.findByText("Studafy Growth");
    fireEvent.click(screen.getByRole("button", { name: "Change plan" }));
    await screen.findByRole("dialog", { name: "Change plan" });
    await screen.findByText(/Studafy Scale/);

    await expectNoA11yViolations(container);
  });

  test("cancel-subscription dialog, open with the reason field showing", async () => {
    const Page = (await import("./BillingOverviewPage")).default;
    const { container } = await renderInPortal(Page, "/portal/billing", "/portal/billing");
    await screen.findByText("Studafy Growth");
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
    await screen.findByRole("dialog", { name: "Cancel subscription?" });

    await expectNoA11yViolations(container);
  });

  test("invoice history, populated with a receipt row", async () => {
    const Page = (await import("./BillingInvoicesPage")).default;
    const { container } = await renderInPortal(
      Page,
      "/portal/billing/invoices",
      "/portal/billing/invoices",
    );
    await screen.findByRole("heading", { name: "Invoices" });
    await screen.findByText("paid");

    await expectNoA11yViolations(container);
  });
});
