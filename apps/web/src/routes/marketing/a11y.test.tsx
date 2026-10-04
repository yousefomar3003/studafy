import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { forwardRef } from "react";
import { MemoryRouter } from "react-router-dom";

import { MarketingFooter } from "../../layouts/marketing/MarketingFooter";
import { MarketingHeader } from "../../layouts/marketing/MarketingHeader";
import { AuthProvider, createSessionStore } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";

import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the public marketing site — previously untested for a11y
 * entirely. Each page is rendered with the same header/footer/`<main>` nesting `MarketingLayout`
 * and `RootLayout` produce for a real visit (see `routes.tsx`: `RootLayout > MarketingLayout >
 * <page>`), since the header's nav and footer are part of every marketing route's accessible tree.
 */

const PLAN = {
  id: "plan-1",
  code: "growth",
  displayName: "Studafy Growth",
  description: "For growing schools.",
  prices: [
    { billingInterval: "monthly", currencyCode: "USD", amountMinor: 9900 },
    { billingInterval: "yearly", currencyCode: "USD", amountMinor: 99000 },
  ],
};

const getMock = mock((_path: string) => Promise.resolve<unknown>({ data: [PLAN] }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));
// Cloudflare's script does not load in happy-dom; the delete-account form renders the widget.
mock.module("../../components/TurnstileWidget", () => ({
  TurnstileWidget: forwardRef(function MockTurnstileWidget() {
    return null;
  }),
}));

const loadHomePage = async (): Promise<ComponentType> => (await import("./HomePage")).default;
const loadFeaturesPage = async (): Promise<ComponentType> =>
  (await import("./FeaturesPage")).default;
const loadPricingPage = async (): Promise<ComponentType> => (await import("./PricingPage")).default;
const loadAboutPage = async (): Promise<ComponentType> => (await import("./AboutPage")).default;
const loadPrivacyPolicyPage = async (): Promise<ComponentType> =>
  (await import("../legal/PrivacyPolicyPage")).default;
const loadDeleteAccountInfoPage = async (): Promise<ComponentType> =>
  (await import("../legal/DeleteAccountInfoPage")).default;
const loadConfirmAccountDeletionPage = async (): Promise<ComponentType> =>
  (await import("../legal/ConfirmAccountDeletionPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A signed-out visitor: the header shows "Sign in" and never probes the refresh endpoint.
  const store = createSessionStore({
    refreshClient: {
      refresh: () => Promise.reject(new Error("no session")),
      logout: () => Promise.resolve(),
    },
  });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <main id="main">
            <div className="marketing-shell">
              <MarketingHeader
                navId="marketing-nav"
                navOpen={false}
                onToggleNav={() => undefined}
              />
              <Page />
              <MarketingFooter />
            </div>
          </main>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("marketing site accessibility", () => {
  test("home page", async () => {
    const { container } = renderPage(await loadHomePage());
    await expectNoA11yViolations(container);
  });

  test("features page", async () => {
    const { container } = renderPage(await loadFeaturesPage());
    await expectNoA11yViolations(container);
  });

  test("pricing page, plans loaded", async () => {
    const { container } = renderPage(await loadPricingPage());
    await screen.findByText("Studafy Growth");
    await expectNoA11yViolations(container);
  });

  test("about page", async () => {
    const { container } = renderPage(await loadAboutPage());
    await expectNoA11yViolations(container);
  });

  test("privacy policy page", async () => {
    const { container } = renderPage(await loadPrivacyPolicyPage());
    await expectNoA11yViolations(container);
  });

  test("delete-account info page", async () => {
    const { container } = renderPage(await loadDeleteAccountInfoPage());
    await expectNoA11yViolations(container);
  });

  test("delete-account confirm page", async () => {
    const { container } = renderPage(await loadConfirmAccountDeletionPage());
    await expectNoA11yViolations(container);
  });
});
