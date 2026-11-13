import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { callTo, renderFinance } from "../test-utils";

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "invoice-1",
    school_id: "school-1",
    student_id: "student-1",
    student_name: "Omar Saleh",
    admission_number: "ADM-1",
    erpnext_docname: "ACC-SINV-0001",
    erpnext_status: "submitted",
    total_amount: "1050.000",
    total_amount_minor: 1_050_000,
    outstanding_amount: "1050.000",
    outstanding_amount_minor: 1_050_000,
    currency: "JOD",
    currency_minor_unit: 3,
    issued_date: "2026-09-01",
    due_date: "2026-09-30",
    last_synced_at: "2026-09-01T00:00:00.000Z",
    family_id: null,
    family_name: null,
    lines: [{ fee_category: "Tuition", description: null, quantity: 1, amount: 1000 }],
    net_total: 1000,
    taxes: [{ description: "VAT 5%", rate: 5, amount: 50 }],
    tax_registration_number: "100234567800003",
    ...overrides,
  };
}

let invoice = makeInvoice();
let refunds: Record<string, unknown>[] = [];

const getMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/finance/invoices/{invoiceId}") return Promise.resolve({ data: invoice });
  if (path === "/api/finance/refunds") {
    return Promise.resolve({ data: { refunds, total: refunds.length } });
  }
  return Promise.resolve({ data: undefined });
});
const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve({ data: { id: "refund-9", kind: "invoice_cancellation" } }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async () => (await import("./InvoiceDetailPage")).default;

async function renderPage(roles: string[] = ["FINANCE"]) {
  const Page = await loadPage();
  return renderFinance(<Page />, {
    roles,
    path: "/portal/finance/invoices/invoice-1",
    routePath: "/portal/finance/invoices/:invoiceId",
  });
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  invoice = makeInvoice();
  refunds = [];
});

describe("InvoiceDetailPage", () => {
  test("shows the tax rows, the net total and the school's registration number", async () => {
    await renderPage();
    await screen.findByRole("heading", { name: "Invoice ACC-SINV-0001" });
    expect(screen.getByText("100234567800003")).toBeTruthy();
    expect(screen.getByText("VAT 5%")).toBeTruthy();
    expect(screen.getByText("Net total")).toBeTruthy();
  });

  test("an unpaid invoice can be asked to be cancelled, with a reason", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel invoice" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask to cancel this invoice?" });
    fireEvent.change(within(dialog).getByLabelText(/Why/), {
      target: { value: "Billed the wrong structure" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask to cancel" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(callTo(postMock.mock.calls, "/api/finance/invoices/{invoiceId}/cancellation")).toEqual({
      params: { path: { invoiceId: "invoice-1" } },
      body: { reason_code: "error_correction", reason_notes: "Billed the wrong structure" },
    });
  });

  test("a part-paid invoice offers a credit note and a write-off, not a cancellation", async () => {
    invoice = makeInvoice({ outstanding_amount: "300.000", outstanding_amount_minor: 300_000 });
    await renderPage();
    await screen.findByRole("heading", { name: "Invoice ACC-SINV-0001" });

    expect(screen.queryByRole("button", { name: "Cancel invoice" })).toBeNull();
    expect(screen.getByRole("link", { name: "Write off balance" }).getAttribute("href")).toBe(
      "/portal/finance/adjustments/refunds/new?invoiceId=invoice-1&reason=write_off",
    );
    expect(screen.getByRole("link", { name: "Credit note" }).getAttribute("href")).toBe(
      "/portal/finance/adjustments/refunds/new?invoiceId=invoice-1&reason=error_correction",
    );
  });

  test("lists the corrections asked for this invoice only", async () => {
    refunds = [
      {
        id: "r-1",
        kind: "invoice_cancellation",
        status: "pending_approval",
        amount: "1050.000",
        currency: "JOD",
        erpnext_invoice_id: "ACC-SINV-0001",
      },
      {
        id: "r-2",
        kind: "credit_note",
        status: "completed",
        amount: "10.000",
        currency: "JOD",
        erpnext_invoice_id: "ACC-SINV-0999",
      },
    ];
    await renderPage();
    const section = await screen.findByRole("region", { name: "Refunds and corrections" });
    expect(
      within(section).getByRole("link", { name: "Invoice cancellation" }).getAttribute("href"),
    ).toBe("/portal/finance/adjustments/refunds/r-1");
    expect(within(section).queryByText(/10\.000/)).toBeNull();
  });

  test("a read-only role sees no corrections", async () => {
    await renderPage(["SUPPORT_AGENT"]);
    await screen.findByRole("heading", { name: "Invoice ACC-SINV-0001" });
    expect(screen.queryByRole("button", { name: "Cancel invoice" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Credit note" })).toBeNull();
  });
});
