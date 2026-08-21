import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

/** Automated accessibility audit for the scholarship award and refund screens, mirroring
 * `payments/a11y.test.tsx`. */

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

const AWARD = {
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
};

const REFUND = {
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
};

const INVOICE = {
  id: "invoice-1",
  school_id: "school-1",
  student_id: "student-1",
  student_name: "Layla Haddad",
  admission_number: "ADM-001",
  erpnext_docname: "ACC-SINV-2026-00001",
  erpnext_status: "submitted",
  total_amount: "1000.000",
  total_amount_minor: 1000000,
  outstanding_amount: "400.000",
  outstanding_amount_minor: 400000,
  currency: "JOD",
  currency_minor_unit: 3,
  issued_date: "2026-08-01",
  due_date: "2026-09-01",
  last_synced_at: "2026-08-01T00:00:00.000Z",
};

const STUDENT = {
  id: "student-1",
  first_name: "Layla",
  last_name: "Haddad",
  admission_number: "ADM-001",
};

const getMock = mock((path: string) => {
  if (path === "/api/finance/scholarship-discounts/awards") {
    return Promise.resolve({ data: { awards: [AWARD], total: 1 } });
  }
  if (path === "/api/finance/scholarship-discounts") {
    return Promise.resolve({ data: { scholarship_discounts: [DISCOUNT], total: 1 } });
  }
  if (path === "/api/finance/refunds") {
    return Promise.resolve({ data: { refunds: [REFUND], total: 1 } });
  }
  if (path === "/api/finance/invoices") {
    return Promise.resolve({ data: { invoices: [INVOICE], next_cursor: null } });
  }
  if (path === "/api/students") {
    return Promise.resolve({ data: { students: [STUDENT], total: 1 } });
  }
  return Promise.resolve({ data: undefined });
});
mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

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

describe("scholarship award and refund screens accessibility", () => {
  test("scholarship awards list, populated with a confirm action", async () => {
    const Page = (await import("./ScholarshipAwardsListPage")).default;
    const { container } = await renderInPortal(
      Page,
      "/portal/finance/adjustments/scholarships",
      "/portal/finance/adjustments/scholarships",
    );
    await screen.findByRole("heading", { name: /Scholarship/ });
    await screen.findByText("Sibling discount");

    await expectNoA11yViolations(container);
  });

  test("scholarship award confirmation dialog, open with the computed effect shown", async () => {
    const Page = (await import("./ScholarshipAwardsListPage")).default;
    const { container } = await renderInPortal(
      Page,
      "/portal/finance/adjustments/scholarships",
      "/portal/finance/adjustments/scholarships",
    );
    await screen.findByText("Sibling discount");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByRole("dialog", { name: "Confirm scholarship award?" });

    await expectNoA11yViolations(container);
  });

  test("new scholarship award form, student and discount selected", async () => {
    const Page = (await import("./NewScholarshipAwardPage")).default;
    const { container } = await renderInPortal(
      Page,
      "/portal/finance/adjustments/scholarships/new",
      "/portal/finance/adjustments/scholarships/new",
    );
    await screen.findByRole("heading", { name: "Award a scholarship or discount" });

    fireEvent.change(screen.getByLabelText("Student", { exact: false }), {
      target: { value: "Layla" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Layla Haddad/ }));
    fireEvent.click(screen.getByRole("combobox", { name: "Scholarship / discount" }));
    fireEvent.click(screen.getByRole("option", { name: "Sibling discount" }));
    await screen.findByText(/off all fee categories/);

    await expectNoA11yViolations(container);
  });

  test("refunds list, populated with approve and reject actions", async () => {
    const Page = (await import("./RefundsListPage")).default;
    const { container } = await renderInPortal(
      Page,
      "/portal/finance/adjustments/refunds",
      "/portal/finance/adjustments/refunds",
    );
    await screen.findByRole("heading", { name: "Refunds" });
    await screen.findByText("ACC-SINV-2026-00001");

    await expectNoA11yViolations(container);
  });

  test("refund rejection dialog, open with the reason field showing its validation error", async () => {
    const Page = (await import("./RefundsListPage")).default;
    const { container } = await renderInPortal(
      Page,
      "/portal/finance/adjustments/refunds",
      "/portal/finance/adjustments/refunds",
    );
    await screen.findByText("ACC-SINV-2026-00001");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject refund" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    await within(dialog).findByText("A reason is required to reject.");

    await expectNoA11yViolations(container);
  });

  test("new refund form, invoice selected and the paid-amount cap shown", async () => {
    const Page = (await import("./NewRefundPage")).default;
    const { container } = await renderInPortal(
      Page,
      "/portal/finance/adjustments/refunds/new",
      "/portal/finance/adjustments/refunds/new",
    );
    await screen.findByRole("heading", { name: "Request a refund" });

    fireEvent.change(screen.getByLabelText("Invoice", { exact: false }), {
      target: { value: "Layla" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /ACC-SINV-2026-00001/ }));
    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "100" },
    });
    await screen.findByText(/Up to 600.000 JOD can be refunded/);

    await expectNoA11yViolations(container);
  });
});
