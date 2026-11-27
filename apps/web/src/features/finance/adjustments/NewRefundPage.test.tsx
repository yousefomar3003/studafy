import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  outstanding_amount: "400.000",
  outstanding_amount_minor: 400000,
  currency: "JOD",
  currency_minor_unit: 3,
  issued_date: "2026-08-01",
  due_date: "2026-09-01",
  last_synced_at: "2026-08-01T00:00:00.000Z",
};

const CREATED_REFUND = {
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
  kind: "credit_note",
  reason_code: "overpayment",
  reason_notes: null,
  payout_mode: "cash",
  settlement: "pending",
  paid_out_amount: "0.000",
  paid_out_amount_minor: 0,
  receipt_url: null,
  status: "pending_approval",
  maker_id: "user-1",
  checker_id: null,
  approved_at: null,
  completed_at: null,
  created_at: "2026-08-21T00:00:00.000Z",
  updated_at: "2026-08-21T00:00:00.000Z",
};

const getMock = mock((path: string) => {
  if (path === "/api/finance/invoices") {
    return Promise.resolve({ data: { invoices: [INVOICE], next_cursor: null } });
  }
  return Promise.resolve({ data: undefined });
});

let initiateRefundCalls = 0;
const postMock = mock(
  (path: string, _init?: { body: Record<string, unknown>; params?: { header?: unknown } }) => {
    if (path === "/api/finance/refunds/initiate") {
      initiateRefundCalls += 1;
      return Promise.resolve({ data: CREATED_REFUND });
    }
    return Promise.resolve({ data: undefined });
  },
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./NewRefundPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/portal/finance/adjustments/refunds/new"]}>
          <Page />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function pickInvoice() {
  fireEvent.change(screen.getByLabelText("Invoice", { exact: false }), {
    target: { value: "Layla" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /ACC-SINV-2026-00001/ }));
}

/** `Select` is a custom listbox, not a native `<select>` — open it, then click the option. */
function pickReason(label: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Reason" }));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  initiateRefundCalls = 0;
});

describe("NewRefundPage", () => {
  test("caps the refund amount at the invoice's paid-to-date amount", async () => {
    renderPage(await loadPage());

    await pickInvoice();

    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "50" },
    });

    // Paid to date = total (1000.000) - outstanding (400.000) = 600.000.
    await screen.findByText(/Up to 600.000 JOD can be refunded on this invoice\./);

    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "700" },
    });

    await screen.findByText(
      /This exceeds the paid amount on this invoice \(600.000 JOD\)\. Reduce the amount to continue\./,
    );

    pickReason("Overpayment");

    expect(screen.getByRole("button", { name: "Review refund" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  test("requests a refund within the cap, confirming the exact effect before it commits", async () => {
    renderPage(await loadPage());

    await pickInvoice();

    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "100" },
    });
    pickReason("Overpayment");

    fireEvent.click(screen.getByRole("button", { name: "Review refund" }));

    const dialog = await screen.findByRole("dialog", { name: "Request refund?" });
    expect(dialog.textContent).toContain("100.000 JOD");
    expect(dialog.textContent).toContain("ACC-SINV-2026-00001");

    fireEvent.click(screen.getByRole("button", { name: "Request refund" }));

    expect(await screen.findByText("Refund requested — 100.000 JOD")).toBeTruthy();
    expect(initiateRefundCalls).toBe(1);

    const [, init] = postMock.mock.calls[0] as [
      string,
      { body: Record<string, unknown>; params: { header: Record<string, string> } },
    ];
    expect(init.body).toEqual({
      student_id: "student-1",
      erpnext_invoice_id: "ACC-SINV-2026-00001",
      amount: 100,
      currency: "JOD",
      reason_code: "overpayment",
      reason_notes: undefined,
      payout_mode: "cash",
    });
    expect(init.params.header["idempotency-key"]).toBeTruthy();
  });

  test("says what approval will do with the money: off the invoice first, the rest back in cash", async () => {
    renderPage(await loadPage());
    await pickInvoice();
    pickReason("Overpayment");

    // The invoice still owes 400.000: a refund of 100 all comes off it.
    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "100" },
    });
    await screen.findByText(
      "All 100.000 JOD will be taken off what this invoice still owes. No money is handed back.",
    );

    // 500 is more than is owed: 400 off the invoice, 100 handed back in cash (the default).
    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "500" },
    });
    await screen.findByText(
      "400.000 JOD will be taken off what this invoice still owes, and 100.000 JOD handed back by Cash when it is approved.",
    );
  });

  test("keeping it as credit is sent as the payout mode", async () => {
    renderPage(await loadPage());
    await pickInvoice();
    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "500" },
    });
    pickReason("Overpayment");
    fireEvent.click(screen.getByRole("combobox", { name: "How the money is given back" }));
    fireEvent.click(screen.getByRole("option", { name: "Keep as credit for a later invoice" }));
    await screen.findByText(
      "400.000 JOD will be taken off what this invoice still owes, and 100.000 JOD kept as credit on the family's account.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Review refund" }));
    await screen.findByRole("dialog", { name: "Request refund?" });
    fireEvent.click(screen.getByRole("button", { name: "Request refund" }));
    await waitFor(() => expect(initiateRefundCalls).toBe(1));
    const [, init] = postMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(init.body.payout_mode).toBe("credit");
  });

  test("a write-off never hands money back, so it does not ask how", async () => {
    renderPage(await loadPage());
    await pickInvoice();
    pickReason("Write-off");
    expect(screen.queryByRole("combobox", { name: "How the money is given back" })).toBeNull();
  });
});
