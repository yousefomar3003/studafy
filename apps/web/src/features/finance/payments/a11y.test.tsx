import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { ComponentType } from "react";

/** Automated accessibility audit for the payment recording screens, mirroring
 * `invoices/a11y.test.tsx`. */

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
  outstanding_amount: "1000.000",
  outstanding_amount_minor: 1000000,
  currency: "JOD",
  currency_minor_unit: 3,
  issued_date: "2026-08-01",
  due_date: "2026-09-01",
  last_synced_at: "2026-08-01T00:00:00.000Z",
};

const PENDING_PAYMENT = {
  id: "payment-1",
  school_id: "school-1",
  student_id: "student-1",
  erpnext_payment_entry_id: null,
  erpnext_invoice_id: "ACC-SINV-2026-00001",
  amount: "500",
  amount_minor: 500000,
  currency: "JOD",
  currency_minor_unit: 3,
  payment_mode: "cash",
  status: "pending",
  erpnext_status: "Draft",
  receipt_url: null,
  payment_date: "2026-08-21",
  confirmed_at: null,
  last_synced_at: "2026-08-21T00:00:00.000Z",
};

const CONFIRMED_PAYMENT = {
  ...PENDING_PAYMENT,
  status: "confirmed",
  erpnext_status: "Submitted",
  receipt_url: "https://erpnext.example.com/receipts/payment-1",
  confirmed_at: "2026-08-21T00:01:00.000Z",
};

const getMock = mock((path: string) => {
  if (path === "/api/finance/invoices") {
    return Promise.resolve({ data: { invoices: [INVOICE], next_cursor: null } });
  }
  if (path === "/api/finance/payments") {
    return Promise.resolve({ data: { payments: [CONFIRMED_PAYMENT], total: 1 } });
  }
  if (path === "/api/finance/payments/{paymentId}") {
    return Promise.resolve({ data: CONFIRMED_PAYMENT });
  }
  return Promise.resolve({ data: undefined });
});
const postMock = mock((path: string) => {
  if (path === "/api/finance/payments") {
    return Promise.resolve({ data: PENDING_PAYMENT });
  }
  return Promise.resolve({ data: undefined });
});
mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

function renderInPortal(Page: ComponentType, initialPath: string, routePath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
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
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("payment screens accessibility", () => {
  test("payments list, populated", async () => {
    const Page = (await import("./PaymentsListPage")).default;
    const { container } = renderInPortal(
      Page,
      "/portal/finance/payments",
      "/portal/finance/payments",
    );
    await screen.findByRole("heading", { name: "Payments" });
    await screen.findByText("ACC-SINV-2026-00001");

    await expectNoA11yViolations(container);
  });

  test("record payment form, invoice selected and math shown", async () => {
    const Page = (await import("./RecordPaymentPage")).default;
    const { container } = renderInPortal(
      Page,
      "/portal/finance/payments/new",
      "/portal/finance/payments/new",
    );
    await screen.findByRole("heading", { name: "Record a payment" });

    fireEvent.change(screen.getByLabelText("Invoice", { exact: false }), {
      target: { value: "Layla" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /ACC-SINV-2026-00001/ }));
    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "500" },
    });
    await screen.findByText(/Partial payment/);

    await expectNoA11yViolations(container);
  });

  test("payment recorded, confirmed with a receipt", async () => {
    const Page = (await import("./RecordPaymentPage")).default;
    const { container } = renderInPortal(
      Page,
      "/portal/finance/payments/new",
      "/portal/finance/payments/new",
    );
    await screen.findByRole("heading", { name: "Record a payment" });

    fireEvent.change(screen.getByLabelText("Invoice", { exact: false }), {
      target: { value: "Layla" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /ACC-SINV-2026-00001/ }));
    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "500" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Cash" }));
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));

    await screen.findByRole("link", { name: "Open receipt" });

    await expectNoA11yViolations(container);
  });
});
