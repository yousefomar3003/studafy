import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

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

const CREATED_PAYMENT = {
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

// The success panel's first poll already sees the payment confirmed — this test covers the
// form -> success -> receipt transition, not the 3s polling interval itself, same shortcut
// `InvoiceBatchPage.test.tsx` takes for its progress panel.
const CONFIRMED_PAYMENT = {
  ...CREATED_PAYMENT,
  status: "confirmed",
  erpnext_status: "Submitted",
  receipt_url: "https://erpnext.example.com/receipts/payment-1",
  confirmed_at: "2026-08-21T00:01:00.000Z",
};

const getMock = mock((path: string) => {
  if (path === "/api/finance/invoices") {
    return Promise.resolve({ data: { invoices: [INVOICE], next_cursor: null } });
  }
  if (path === "/api/finance/payments/{paymentId}") {
    return Promise.resolve({ data: CONFIRMED_PAYMENT });
  }
  return Promise.resolve({ data: undefined });
});

let createPaymentCalls = 0;
const postMock = mock(
  (path: string, _init?: { body: Record<string, unknown>; params?: { header?: unknown } }) => {
    if (path === "/api/finance/payments") {
      createPaymentCalls += 1;
      return Promise.resolve({ data: CREATED_PAYMENT });
    }
    return Promise.resolve({ data: undefined });
  },
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./RecordPaymentPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/portal/finance/payments/new"]}>
          <Page />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function fillOutForm() {
  // `{ exact: false }`: the label text is followed by a `*` required marker with no separating
  // space (see `Input`'s doc comment / markup), so an exact match on "Invoice"/"Amount" alone
  // fails — same workaround `FeeStructureBuilderPage.test.tsx` uses for its own required fields.
  fireEvent.change(screen.getByLabelText("Invoice", { exact: false }), {
    target: { value: "Layla" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /ACC-SINV-2026-00001/ }));

  fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
    target: { value: "500" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "Cash" }));
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  createPaymentCalls = 0;
});

describe("RecordPaymentPage", () => {
  test("looks up an invoice, records a partial payment, and opens the receipt once confirmed", async () => {
    renderPage(await loadPage());

    await fillOutForm();

    // Partial payment math, live: 1000.000 outstanding minus a 500 payment.
    await screen.findByText(/Partial payment — 500.000 JOD will remain outstanding\./);

    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));

    expect(await screen.findByText("Payment recorded — 500 JOD")).toBeTruthy();

    const [, init] = postMock.mock.calls[0] as [
      string,
      { body: Record<string, unknown>; params: { header: Record<string, string> } },
    ];
    expect(init.body).toEqual({
      student_id: "student-1",
      invoice_id: "ACC-SINV-2026-00001",
      amount: 500,
      payment_mode: "cash",
      currency: "JOD",
      reference_no: undefined,
      reference_date: undefined,
      posting_date: undefined,
      remarks: undefined,
    });
    expect(init.params.header["idempotency-key"]).toBeTruthy();

    const receiptLink = await screen.findByRole("link", { name: "Open receipt" });
    expect(receiptLink.getAttribute("href")).toBe("https://erpnext.example.com/receipts/payment-1");
  });

  test("double-clicking submit records the payment exactly once", async () => {
    renderPage(await loadPage());

    await fillOutForm();

    const submitButton = screen.getByRole("button", { name: "Record payment" });
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    await screen.findByText("Payment recorded — 500 JOD");

    expect(createPaymentCalls).toBe(1);
  });
});
