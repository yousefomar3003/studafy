import { ApiError } from "@studafy/api-client";
import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";

import type { SessionTokens } from "../../lib/auth";
import type { ComponentType } from "react";

const STUDENT_ID = "11111111-1111-1111-1111-111111111111";
const PRICE_ID = "22222222-2222-2222-2222-222222222222";

function makeStudent(overrides: Record<string, unknown> = {}) {
  return {
    id: STUDENT_ID,
    school_id: "school-1",
    user_id: "user-1",
    first_name: "Amina",
    middle_name: null,
    last_name: "Hassan",
    preferred_name: null,
    date_of_birth: null,
    nationality_country_id: null,
    status: "enrolled",
    admission_number: "",
    admission_date: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let currentStudent: Record<string, unknown> | undefined = makeStudent();
let checkoutError: ApiError | null = null;

const getMock = mock((path: string) => {
  if (path === "/api/students/{studentId}") {
    return Promise.resolve({ data: currentStudent });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string) => {
  if (path === "/api/subscriptions/ai/checkout") {
    if (checkoutError) {
      return Promise.reject(checkoutError);
    }
    return Promise.resolve({
      data: { url: "https://checkout.stripe.com/session-123", sessionId: "sess-123" },
    });
  }
  return Promise.resolve({ data: undefined });
});

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

// `useStartAiCheckout` redirects via `window.location.assign` on success — stubbed the same way
// `BillingOverviewPage.test.tsx` stubs it rather than letting happy-dom attempt a real navigation.
const assignMock = mock((_url: string) => undefined);
window.location.assign = assignMock;

const loadPage = async (): Promise<ComponentType> =>
  (await import("./AiSubscriptionPurchasePage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderPage(Page: ComponentType, initialPath: string) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: ["PARENT"], sub: "user-current" }),
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
  currentStudent = makeStudent();
  checkoutError = null;
});

describe("AiSubscriptionPurchasePage", () => {
  test("shows an invalid-link message when the deep link is missing studentId/priceId", async () => {
    await renderPage(await loadPage(), "/account/ai");

    await screen.findByText(/missing some information/);
    expect(getMock).not.toHaveBeenCalled();
  });

  test("renders the plan explainer with the student's name and starts checkout on subscribe", async () => {
    await renderPage(await loadPage(), `/account/ai?studentId=${STUDENT_ID}&priceId=${PRICE_ID}`);

    await screen.findByText(/A personal AI tutor for Amina Hassan/);

    fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));

    await screen.findByRole("button", { name: "Subscribe" });
    expect(postMock).toHaveBeenCalledWith(
      "/api/subscriptions/ai/checkout",
      expect.objectContaining({
        body: expect.objectContaining({ studentId: STUDENT_ID, priceId: PRICE_ID }),
      }),
    );
    expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.com/session-123");
  });

  test("shows the inactive-school blocked state when checkout refuses with that code", async () => {
    checkoutError = new ApiError({
      status: 400,
      title: "Bad Request",
      code: "AI_SUBSCRIPTION_SCHOOL_NOT_ACTIVE",
      detail: "Cannot purchase AI access: school subscription is not active",
      instance: null,
      type: null,
      request_id: null,
      problem: null,
    });
    await renderPage(await loadPage(), `/account/ai?studentId=${STUDENT_ID}&priceId=${PRICE_ID}`);

    fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));

    await screen.findByText("Purchase blocked");
    expect(screen.getByText(/isn.t active right now/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull();
  });

  test("shows the success state instructing the parent to return to the app", async () => {
    await renderPage(
      await loadPage(),
      `/account/ai?studentId=${STUDENT_ID}&priceId=${PRICE_ID}&checkout=success`,
    );

    await screen.findByRole("heading", { name: /all set/ });
    await screen.findByText(/Return to the Studafy app on your phone/);
    expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull();
  });

  test("shows a cancelled notice and still offers to retry", async () => {
    await renderPage(
      await loadPage(),
      `/account/ai?studentId=${STUDENT_ID}&priceId=${PRICE_ID}&checkout=cancelled`,
    );

    await screen.findByText("Checkout cancelled");
    expect(await screen.findByRole("button", { name: "Subscribe" })).toBeTruthy();
  });

  test("shows an error when the student can't be found on this account", async () => {
    currentStudent = undefined;
    await renderPage(await loadPage(), `/account/ai?studentId=${STUDENT_ID}&priceId=${PRICE_ID}`);

    await screen.findByText(/couldn.t find this student/);
    expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull();
  });
});
