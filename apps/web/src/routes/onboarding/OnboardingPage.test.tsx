import { ApiError } from "@studafy/api-client";
import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { forwardRef, useEffect, useImperativeHandle } from "react";

import type { ComponentType, Ref } from "react";

/**
 * Integration test for the school self-registration wizard, mirroring
 * `routes/invite/InvitePage.test.tsx`'s pattern: `../../lib/api` is stubbed so no network call is
 * made, and the page is imported dynamically after the mock is registered.
 *
 * `../../components/TurnstileWidget` is also stubbed — it loads a real script from
 * challenges.cloudflare.com, which does not resolve in the happy-dom test environment. The stub
 * fires `onToken` once on mount, the same as a solved real challenge.
 */

const COUNTRIES = [{ id: "country-1", alpha2_code: "US", name: "United States" }];
const CURRENCIES = [{ id: "currency-1", code: "USD", name: "US Dollar" }];

const REGISTER_RESPONSE = {
  school: {
    id: "school-1",
    slug: "springfield-academy",
    name: "Springfield Academy",
    status: "registered" as const,
    created_at: "2026-08-13T00:00:00.000Z",
  },
  admin: { id: "admin-1", email: "principal@springfield-academy.edu", role: "ORG_ADMIN" as const },
  invitation: { token: "inv-token", expires_at: "2026-08-20T00:00:00.000Z" },
  verification: { token: "ver-token", expires_at: "2026-08-14T00:00:00.000Z" },
};

function apiError(status: number, code: string, detail: string | null = null) {
  return new ApiError({
    status,
    title: code,
    code: code as never,
    detail,
    instance: null,
    type: null,
    request_id: "req-1",
    problem: null,
  });
}

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

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Page />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Fills and submits step 1, landing on the administrator-contact step. */
async function completeSchoolDetailsStep() {
  fireEvent.change(screen.getByLabelText(/school name/i), {
    target: { value: "Springfield Academy" },
  });
  fireEvent.change(screen.getByLabelText(/school contact email/i), {
    target: { value: "hello@springfield-academy.edu" },
  });

  // The country/currency triggers stay `disabled` until their lookup queries resolve, and a
  // disabled button swallows clicks — so wait for the placeholder to flip from "Loading…" before
  // opening either.
  await screen.findByText("Select a country");
  fireEvent.click(screen.getByRole("combobox", { name: /^country/i }));
  fireEvent.click(await screen.findByRole("option", { name: /united states/i }));

  await screen.findByText("Select a currency");
  fireEvent.click(screen.getByRole("combobox", { name: /^default currency/i }));
  fireEvent.click(await screen.findByRole("option", { name: /us dollar/i }));

  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  await screen.findByRole("heading", { name: /administrator contact/i });
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockReset();
});

describe("OnboardingPage", () => {
  test("completes the full registration flow and offers a resend", async () => {
    postMock.mockImplementation((path: string) => {
      if (path === "/api/schools/register") {
        return Promise.resolve({ data: REGISTER_RESPONSE });
      }
      if (path === "/api/schools/resend-verification") {
        return Promise.resolve({ data: { message: "sent" } });
      }
      return Promise.resolve({ data: undefined });
    });

    renderPage(await loadOnboardingPage());
    await completeSchoolDetailsStep();

    fireEvent.change(screen.getByLabelText(/administrator email/i), {
      target: { value: "principal@springfield-academy.edu" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create school account/i }));

    await screen.findByRole("heading", { name: /springfield academy is registered/i });
    expect(screen.getByText("hello@springfield-academy.edu")).toBeTruthy();
    expect(screen.getByText("principal@springfield-academy.edu")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /resend verification email/i }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/api/schools/resend-verification",
        expect.objectContaining({ body: { email: "hello@springfield-academy.edu" } }),
      );
    });
  });

  test("a duplicate slug sends the user back to step 1 with an inline field error", async () => {
    postMock.mockImplementation((path: string) => {
      if (path === "/api/schools/register") {
        return Promise.reject(apiError(409, "SCHOOL_SLUG_DUPLICATE"));
      }
      return Promise.resolve({ data: undefined });
    });

    renderPage(await loadOnboardingPage());
    await completeSchoolDetailsStep();

    fireEvent.change(screen.getByLabelText(/administrator email/i), {
      target: { value: "principal@springfield-academy.edu" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create school account/i }));

    await screen.findByRole("heading", { name: /school details/i });
    expect(await screen.findByText(/already taken/i)).toBeTruthy();
  });

  test("a duplicate school email sends the user back to step 1 with an inline field error", async () => {
    postMock.mockImplementation((path: string) => {
      if (path === "/api/schools/register") {
        return Promise.reject(apiError(409, "SCHOOL_EMAIL_DUPLICATE"));
      }
      return Promise.resolve({ data: undefined });
    });

    renderPage(await loadOnboardingPage());
    await completeSchoolDetailsStep();

    fireEvent.change(screen.getByLabelText(/administrator email/i), {
      target: { value: "principal@springfield-academy.edu" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create school account/i }));

    await screen.findByRole("heading", { name: /school details/i });
    expect(await screen.findByText(/already exists/i)).toBeTruthy();
  });

  test("a generic validation failure renders the server's detail as a banner", async () => {
    postMock.mockImplementation((path: string) => {
      if (path === "/api/schools/register") {
        return Promise.reject(apiError(400, "VALIDATION_FAILED", "Captcha verification failed."));
      }
      return Promise.resolve({ data: undefined });
    });

    renderPage(await loadOnboardingPage());
    await completeSchoolDetailsStep();

    fireEvent.change(screen.getByLabelText(/administrator email/i), {
      target: { value: "principal@springfield-academy.edu" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create school account/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/captcha verification failed/i);
  });

  test("a rate-limit failure renders a wait-and-retry banner", async () => {
    postMock.mockImplementation((path: string) => {
      if (path === "/api/schools/register") {
        return Promise.reject(apiError(429, "RATE_LIMIT_EXCEEDED"));
      }
      return Promise.resolve({ data: undefined });
    });

    renderPage(await loadOnboardingPage());
    await completeSchoolDetailsStep();

    fireEvent.change(screen.getByLabelText(/administrator email/i), {
      target: { value: "principal@springfield-academy.edu" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create school account/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/too many attempts/i);
  });

  test("rejects an invalid school email before the request is ever sent", async () => {
    renderPage(await loadOnboardingPage());

    fireEvent.change(screen.getByLabelText(/school name/i), {
      target: { value: "Springfield Academy" },
    });
    fireEvent.change(screen.getByLabelText(/school contact email/i), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText(/enter a valid email address/i)).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });
});
