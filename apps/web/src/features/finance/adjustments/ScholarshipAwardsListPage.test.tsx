import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

const DISCOUNT = {
  id: "discount-1",
  school_id: "school-1",
  erpnext_docname: "SD-0001",
  erpnext_status: "Active",
  title: "Sibling discount",
  discount_type: "fixed",
  amount: 50,
  scope: "global",
  fee_category: null,
  currency: "JOD",
  currency_minor_unit: 3,
  is_active: true,
  last_synced_at: "2026-08-01T00:00:00.000Z",
};

function makeAward(overrides: Record<string, unknown> = {}) {
  return {
    id: "award-1",
    school_id: "school-1",
    student_id: "student-1",
    scholarship_discount_id: "discount-1",
    scholarship_discount_title: "Sibling discount",
    award_status: "pending",
    awarded_by: "user-other",
    confirmed_by: null,
    confirmed_at: null,
    erpnext_docname: null,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

let currentAwards = [makeAward()];

const getMock = mock((path: string) => {
  if (path === "/api/finance/scholarship-discounts/awards") {
    return Promise.resolve({ data: { awards: currentAwards, total: currentAwards.length } });
  }
  if (path === "/api/finance/scholarship-discounts") {
    return Promise.resolve({ data: { scholarship_discounts: [DISCOUNT], total: 1 } });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string) => {
  // openapi-fetch's typed client is mocked wholesale here, so `path` arrives as the literal
  // templated path string (`{awardId}`), not interpolated — same as `RecordPaymentPage.test.tsx`'s
  // own `/api/finance/payments/{paymentId}` mock match.
  if (path === "/api/finance/scholarship-discounts/awards/{awardId}/confirm") {
    return Promise.resolve({
      data: makeAward({ award_status: "confirmed", confirmed_by: "user-current" }),
    });
  }
  return Promise.resolve({ data: undefined });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./ScholarshipAwardsListPage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAs(userId: string, Page: ComponentType) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: ["ORG_ADMIN"], sub: userId }),
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
  currentAwards = [makeAward()];
});

describe("ScholarshipAwardsListPage", () => {
  test("confirming a pending award shows the computed effect and calls the confirm endpoint", async () => {
    await renderAs("user-current", await loadPage());

    await screen.findByText("Sibling discount");

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    const dialog = await screen.findByRole("dialog", { name: "Confirm scholarship award?" });
    expect(dialog.textContent).toContain("50 JOD off all fee categories on every future invoice.");

    fireEvent.click(screen.getByRole("button", { name: "Confirm award" }));

    expect(await screen.findByText("Award confirmed")).toBeTruthy();
    expect(postMock.mock.calls).toHaveLength(1);
  });

  test("disables Confirm on an award the current user awarded themselves", async () => {
    currentAwards = [makeAward({ awarded_by: "user-current" })];

    await renderAs("user-current", await loadPage());

    await screen.findByText("Sibling discount");

    expect(screen.getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(true);
  });
});
