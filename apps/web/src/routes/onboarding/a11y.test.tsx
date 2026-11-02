import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { forwardRef, useEffect, useImperativeHandle } from "react";

import { expectNoA11yViolations } from "../../lib/test/axe";

import type { ComponentType, Ref } from "react";

/**
 * Automated accessibility audit for the school registration flow (ST-184 AC), one structurally
 * distinct render per wizard step — mirrors `routes/invite/a11y.test.tsx`'s approach and rendering
 * inside a `<main>`, matching how `RootLayout` wraps every route in production.
 */

const COUNTRIES = [{ id: "country-1", alpha2_code: "US", name: "United States" }];
const CURRENCIES = [{ id: "currency-1", code: "USD", name: "US Dollar" }];

const getMock = mock((path: string) => {
  if (path === "/api/lookups/countries") {
    return Promise.resolve({ data: { countries: COUNTRIES } });
  }
  if (path === "/api/lookups/currencies") {
    return Promise.resolve({ data: { currencies: CURRENCIES } });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

mock.module("../../components/TurnstileWidget", () => ({
  TurnstileWidget: forwardRef(function MockTurnstileWidget(
    { onToken }: { onToken: (token: string) => void },
    ref: Ref<{ reset: () => void }>,
  ) {
    useImperativeHandle(ref, () => ({ reset: () => undefined }));
    useEffect(() => {
      onToken("test-captcha-token");
    }, [onToken]);
    return null;
  }),
}));

const loadOnboardingPage = async (): Promise<ComponentType> =>
  (await import("./OnboardingPage")).default;

function renderInMain(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <main>
          <Page />
        </main>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockReset();
});

describe("onboarding flow accessibility", () => {
  test("step 1 — school details, once lookups have loaded", async () => {
    const { container } = renderInMain(await loadOnboardingPage());

    await screen.findByText("Select a country");

    await expectNoA11yViolations(container);
  });

  test("step 2 — administrator contact", async () => {
    const { container } = renderInMain(await loadOnboardingPage());

    await screen.findByText("Select a country");
    fireEvent.change(screen.getByLabelText(/school name/i), {
      target: { value: "Springfield Academy" },
    });
    fireEvent.change(screen.getByLabelText(/school contact email/i), {
      target: { value: "hello@springfield-academy.edu" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: /^country/i }));
    fireEvent.click(await screen.findByRole("option", { name: /united states/i }));
    fireEvent.click(screen.getByRole("combobox", { name: /^default currency/i }));
    fireEvent.click(await screen.findByRole("option", { name: /us dollar/i }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { name: /administrator contact/i });

    await expectNoA11yViolations(container);
  });

  test("result step — after a successful registration", async () => {
    postMock.mockImplementation((path: string) => {
      if (path === "/api/schools/register") {
        return Promise.resolve({
          data: {
            school: {
              id: "school-1",
              slug: "springfield-academy",
              name: "Springfield Academy",
              status: "registered" as const,
              created_at: "2026-08-13T00:00:00.000Z",
            },
            admin: {
              id: "admin-1",
              email: "principal@springfield-academy.edu",
              role: "ORG_ADMIN" as const,
            },
            invitation: { token: "inv-token", expires_at: "2026-08-20T00:00:00.000Z" },
            verification: { token: "ver-token", expires_at: "2026-08-14T00:00:00.000Z" },
          },
        });
      }
      return Promise.resolve({ data: undefined });
    });

    const { container } = renderInMain(await loadOnboardingPage());

    await screen.findByText("Select a country");
    fireEvent.change(screen.getByLabelText(/school name/i), {
      target: { value: "Springfield Academy" },
    });
    fireEvent.change(screen.getByLabelText(/school contact email/i), {
      target: { value: "hello@springfield-academy.edu" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: /^country/i }));
    fireEvent.click(await screen.findByRole("option", { name: /united states/i }));
    fireEvent.click(screen.getByRole("combobox", { name: /^default currency/i }));
    fireEvent.click(await screen.findByRole("option", { name: /us dollar/i }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { name: /administrator contact/i });

    fireEvent.change(screen.getByLabelText(/administrator email/i), {
      target: { value: "principal@springfield-academy.edu" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create school account/i }));
    await screen.findByRole("heading", { name: /springfield academy is registered/i });

    await expectNoA11yViolations(container);
  });
});
