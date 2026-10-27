import { ApiError } from "@studafy/api-client";
import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";
import { feature, features, grant } from "../../lib/test/feature-fixtures";

import type { SessionTokens } from "../../lib/auth";
import type { ComponentType } from "react";

const AMINA = "11111111-1111-1111-1111-111111111111";
const OMAR = "33333333-3333-3333-3333-333333333333";
const PRICE_ID = "22222222-2222-2222-2222-222222222222";

function makeOffer(overrides: Record<string, unknown> = {}) {
  return {
    price: { id: PRICE_ID, amountMinor: 499, currency: "USD", interval: "monthly" },
    students: [
      { id: AMINA, name: "Amina Hassan", active: false },
      { id: OMAR, name: "Omar Hassan", active: true },
    ],
    ...overrides,
  };
}

let currentOffer: Record<string, unknown> | undefined = makeOffer();
/** The caller's `GET /api/me/features`; undefined answers no data (the page shows no notice). */
let currentFeatures: unknown = undefined;
let checkoutError: ApiError | null = null;

const getMock = mock((path: string) => {
  if (path === "/api/subscriptions/ai/offer") {
    return Promise.resolve({ data: currentOffer });
  }
  if (path === "/api/me/features") {
    return Promise.resolve({ data: currentFeatures });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string, _init?: { body?: Record<string, unknown> }) => {
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

// The checkout redirect goes through `window.location.assign`; stubbed so happy-dom doesn't attempt
// a real navigation.
const assignMock = mock((_url: string) => undefined);
window.location.assign = assignMock;

const loadPage = async (): Promise<ComponentType> =>
  (await import("./AiSubscriptionPurchasePage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderPage(Page: ComponentType, initialPath = "/account/ai", role = "PARENT") {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: [role], sub: "user-current" }),
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
  currentOffer = makeOffer();
  currentFeatures = undefined;
  checkoutError = null;
});

describe("AiSubscriptionPurchasePage", () => {
  test("shows the price and one purchase per student, with active students marked", async () => {
    await renderPage(await loadPage());

    expect(await screen.findByText("$4.99 per month")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Get AI for Amina Hassan" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Get AI for Omar Hassan" })).toBeNull();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  test("buying starts checkout for that student and goes to the provider's page", async () => {
    await renderPage(await loadPage());

    fireEvent.click(await screen.findByRole("button", { name: "Get AI for Amina Hassan" }));

    await screen.findByRole("button", { name: "Get AI for Amina Hassan" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [path, init] = postMock.mock.calls[0]!;
    expect(path).toBe("/api/subscriptions/ai/checkout");
    expect(init?.body).toMatchObject({ studentId: AMINA, priceId: PRICE_ID });
    expect(String(init?.body?.successUrl)).toContain("checkout=success");
    expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.com/session-123");
  });

  test("says the add-on is not for sale yet when it has no price", async () => {
    currentOffer = makeOffer({ price: null });
    await renderPage(await loadPage());

    expect(await screen.findByText(/isn't available to buy yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Get AI/ })).toBeNull();
  });

  test("explains who can buy it to an account with no student to buy for", async () => {
    currentOffer = makeOffer({ students: [] });
    await renderPage(await loadPage());

    expect(await screen.findByText(/bought for a student/)).toBeTruthy();
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
    await renderPage(await loadPage());

    fireEvent.click(await screen.findByRole("button", { name: "Get AI for Amina Hassan" }));

    expect(await screen.findByText("Purchase blocked")).toBeTruthy();
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("shows the success state after returning from checkout", async () => {
    await renderPage(await loadPage(), "/account/ai?checkout=success");

    expect(await screen.findByRole("heading", { name: "You're all set" })).toBeTruthy();
  });

  test("shows a cancelled notice and still offers to buy", async () => {
    await renderPage(await loadPage(), "/account/ai?checkout=cancelled");

    expect(await screen.findByText("Checkout cancelled")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Get AI for Amina Hassan" })).toBeTruthy();
  });

  describe("what the school provides (docs/billing/feature-licensing.md, session 6)", () => {
    const tutorFeatures = (overrides: Parameters<typeof feature>[0] = {}) =>
      features([feature(overrides)]);

    test("a child holding a school seat: provided by the school, no purchase", async () => {
      currentFeatures = tutorFeatures();
      currentOffer = makeOffer({
        students: [
          { id: AMINA, name: "Amina Hassan", active: false, schoolSeat: true, schoolOffers: true },
          { id: OMAR, name: "Omar Hassan", active: false, schoolSeat: false, schoolOffers: false },
        ],
      });
      await renderPage(await loadPage());

      expect(await screen.findByText("Provided by Alpha Academy")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Get AI for Amina Hassan" })).toBeNull();
      // The other child, whom the school does not provide for, can still be bought for.
      expect(screen.getByRole("button", { name: "Get AI for Omar Hassan" })).toBeTruthy();
    });

    test("the school sells a seat with the AI tutor: ask the school, no purchase", async () => {
      currentFeatures = tutorFeatures();
      currentOffer = makeOffer({
        students: [
          { id: AMINA, name: "Amina Hassan", active: false, schoolSeat: false, schoolOffers: true },
        ],
      });
      await renderPage(await loadPage());

      expect(
        await screen.findByText("Amina Hassan's school provides this: ask the school for a seat."),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Get AI/ })).toBeNull();
    });

    test("a student covered by a seat and a personal add-on: it won't renew", async () => {
      currentFeatures = tutorFeatures({
        active: true,
        reason: null,
        sources: [grant("school_license"), grant("purchase", "2026-11-20T00:00:00.000Z")],
        schoolSeat: true,
        renewalStop: { provider: "stripe", action: "cancel_at_period_end", status: "done" },
      });
      currentOffer = makeOffer({
        students: [
          { id: AMINA, name: "Amina Hassan", active: true, schoolSeat: true, schoolOffers: true },
        ],
      });
      await renderPage(await loadPage(), "/account/ai", "STUDENT");

      expect(
        await screen.findByText(
          "Your school now covers this. Your subscription won't renew after November 20, 2026.",
        ),
      ).toBeTruthy();
      expect(screen.getAllByText("Provided by Alpha Academy").length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: /Get AI/ })).toBeNull();
    });

    test("a student with nothing from the school sees no notice and can buy", async () => {
      currentFeatures = tutorFeatures();
      await renderPage(await loadPage(), "/account/ai", "STUDENT");

      expect(await screen.findByRole("button", { name: "Get AI for Amina Hassan" })).toBeTruthy();
      expect(screen.queryByText(/Provided by/)).toBeNull();
      expect(screen.queryByText(/Ask your school/)).toBeNull();
    });

    test("a refused checkout for a seat holder explains it in words", async () => {
      checkoutError = new ApiError({
        status: 409,
        title: "Conflict",
        code: "AI_SUBSCRIPTION_COVERED_BY_SCHOOL",
        detail: "This student's school provides AI access through a license seat",
        instance: null,
        type: null,
        request_id: null,
        problem: null,
      });
      await renderPage(await loadPage());

      fireEvent.click(await screen.findByRole("button", { name: "Get AI for Amina Hassan" }));

      expect(
        await screen.findByText(
          "The school already provides this through a seat, so there's nothing to buy.",
        ),
      ).toBeTruthy();
      expect(assignMock).not.toHaveBeenCalled();
    });
  });
});
