import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

function makeRefund(overrides: Record<string, unknown> = {}) {
  return {
    id: "refund-1",
    school_id: "school-1",
    payment_entry_id: null,
    erpnext_invoice_id: "ACC-SINV-2026-00001",
    erpnext_credit_note_id: null,
    student_id: "student-1",
    amount: "100.000",
    amount_minor: 100000,
    currency: "JOD",
    currency_minor_unit: 3,
    reason_code: "overpayment",
    reason_notes: null,
    status: "pending_approval",
    maker_id: "user-other",
    checker_id: null,
    approved_at: null,
    completed_at: null,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

let currentRefunds = [makeRefund()];

const getMock = mock((path: string) => {
  if (path === "/api/finance/refunds") {
    return Promise.resolve({ data: { refunds: currentRefunds, total: currentRefunds.length } });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string) => {
  // Same literal-templated-path mocking as `ScholarshipAwardsListPage.test.tsx`'s own confirm mock.
  if (path === "/api/finance/refunds/{refundId}/approve") {
    return Promise.resolve({
      data: makeRefund({ status: "submitted_to_erpnext", checker_id: "user-current" }),
    });
  }
  if (path === "/api/finance/refunds/{refundId}/reject") {
    return Promise.resolve({
      data: makeRefund({ status: "rejected", checker_id: "user-current" }),
    });
  }
  return Promise.resolve({ data: undefined });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./RefundsListPage")).default;

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
  currentRefunds = [makeRefund()];
});

describe("RefundsListPage", () => {
  test("approving a pending refund shows the exact amount and calls the approve endpoint", async () => {
    await renderAs("user-current", await loadPage());

    await screen.findByText("ACC-SINV-2026-00001");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    const dialog = await screen.findByRole("dialog", { name: "Approve refund?" });
    expect(dialog.textContent).toContain("100.000 JOD");
    expect(dialog.textContent).toContain("ACC-SINV-2026-00001");

    fireEvent.click(screen.getByRole("button", { name: "Approve refund" }));

    expect(await screen.findByText("Refund approved")).toBeTruthy();
  });

  test("rejecting a pending refund requires a reason", async () => {
    await renderAs("user-current", await loadPage());

    await screen.findByText("ACC-SINV-2026-00001");

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject refund" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    expect(await within(dialog).findByText("A reason is required to reject.")).toBeTruthy();

    fireEvent.change(dialog.querySelector("textarea")!, {
      target: { value: "Duplicate payment" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));

    expect(await screen.findByText("Refund rejected")).toBeTruthy();
  });

  test("disables Approve and Reject on a refund the current user requested themselves", async () => {
    currentRefunds = [makeRefund({ maker_id: "user-current" })];

    await renderAs("user-current", await loadPage());

    await screen.findByText("ACC-SINV-2026-00001");

    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
  });
});
