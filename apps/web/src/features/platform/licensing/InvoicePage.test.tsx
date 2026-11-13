import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { ComponentType } from "react";

/**
 * One license invoice in the console: its lines, balance and payment reference; recording a bank
 * transfer (never above the balance, in the currency's own minor units, optionally from the school's
 * receipt); matching a pending receipt to a recorded payment; and voiding a payment with a reason.
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "22222222-2222-4222-8222-222222222222";
const PAYMENT_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";

function invoice(currencyCode = "USD", minorUnit = 2) {
  const scale = 10 ** (minorUnit - 2);
  return {
    id: INVOICE_ID,
    schoolId: SCHOOL_ID,
    licenseId: "55555555-5555-4555-8555-555555555555",
    quoteId: null,
    number: "LIC-2026-000042",
    paymentReference: "STF-AB12-CD34",
    status: "partially_paid",
    currencyCode,
    minorUnit,
    issueDate: "2026-10-01",
    dueDate: "2026-10-31",
    subtotalMinor: 100_000 * scale,
    creditTotalMinor: 0,
    adjustmentMinor: 0,
    totalMinor: 100_000 * scale,
    paidMinor: 40_000 * scale,
    balanceMinor: 60_000 * scale,
    overdue: false,
    overdueAt: null,
    voidedAt: null,
    voidReason: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    bankDetails: {
      bankName: "Gulf Bank",
      accountName: "Studafy FZ-LLC",
      iban: "AE070331234567890123456",
      swift: "GULFAEAD",
      currencyCode,
    },
    lines: [
      {
        position: 1,
        kind: "seats",
        audience: "student",
        description: "Student Plus: 100 student seats, 12 months",
        planId: null,
        overlapId: null,
        seats: 100,
        months: 12,
        prorateDays: null,
        listPricePerSeatMonthMinor: 100 * scale,
        listAmountMinor: 120_000 * scale,
        volumeDiscountBps: 1000,
        volumeDiscountMinor: 12_000 * scale,
        durationDiscountBps: 750,
        durationDiscountMinor: 8000 * scale,
        amountMinor: 100_000 * scale,
      },
    ],
    payments: [
      {
        id: PAYMENT_ID,
        invoiceId: INVOICE_ID,
        amountMinor: 40_000 * scale,
        currencyCode,
        receivedAt: "2026-10-05T12:00:00.000Z",
        bankReference: "TRX-1",
        method: "bank_transfer",
        note: null,
        hasReceiptFile: false,
        recordedBy: "66666666-6666-4666-8666-666666666666",
        createdAt: "2026-10-05T12:00:00.000Z",
        voidedAt: null,
        voidReason: null,
      },
    ],
    receipts: [
      {
        id: RECEIPT_ID,
        invoiceId: INVOICE_ID,
        fileName: "transfer.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
        note: "Second instalment",
        status: "pending",
        paymentId: null,
        matchedAt: null,
        uploadedBy: "77777777-7777-4777-8777-777777777777",
        createdAt: "2026-10-20T09:00:00.000Z",
      },
    ],
  };
}

let current = invoice();

const getMock = mock((path: string) => {
  if (path === "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}") {
    return Promise.resolve({ data: current });
  }
  if (path === "/api/platform/schools/{schoolId}") {
    return Promise.resolve({ data: { id: SCHOOL_ID, name: "Alpha Academy" } });
  }
  throw new Error(`Unhandled GET ${path}`);
});
const postMock = mock((path: string, _init?: { body?: Record<string, unknown> }) => {
  if (path === "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments") {
    return Promise.resolve({ data: { payment: current.payments[0], licenseActivated: false } });
  }
  if (path === "/api/platform/schools/{schoolId}/license-receipts/{receiptId}/match") {
    return Promise.resolve({ data: { ...current.receipts[0], status: "matched" } });
  }
  if (path === "/api/platform/schools/{schoolId}/license-payments/{paymentId}/void") {
    return Promise.resolve({ data: current.payments[0] });
  }
  throw new Error(`Unhandled POST ${path}`);
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./InvoicePage")).default;

async function renderPage() {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/portal/platform/payments/${SCHOOL_ID}/${INVOICE_ID}`]}>
          <Routes>
            <Route path="/portal/platform/payments/:schoolId/:invoiceId" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function callsTo(path: string) {
  return postMock.mock.calls.filter(([called]) => called === path).map(([, init]) => init!.body!);
}

afterEach(() => {
  cleanup();
  current = invoice();
  getMock.mockClear();
  postMock.mockClear();
});

describe("InvoicePage", () => {
  test("shows the lines, the balance and how to pay", async () => {
    await renderPage();
    const document = await screen.findByRole("article", { name: "LIC-2026-000042" });
    expect(within(document).getByText("Student Plus: 100 student seats, 12 months")).toBeTruthy();
    expect(within(document).getByText("Volume 10% · Duration 7.5%")).toBeTruthy();
    expect(within(document).getByText("STF-AB12-CD34")).toBeTruthy();
    expect(within(document).getByText("AE070331234567890123456")).toBeTruthy();
    expect(await within(document).findByText("Billed to Alpha Academy")).toBeTruthy();
    const balance = within(document).getByText("Balance").closest("li")!;
    expect(within(balance).getByText("$600.00")).toBeTruthy();
  });

  test("records a transfer up to the balance", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Record a transfer" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Record a transfer for LIC-2026-000042",
    });
    const amount = within(dialog).getByLabelText("Amount (USD)") as HTMLInputElement;
    const confirm = within(dialog).getByRole("button", {
      name: "Record transfer",
    }) as HTMLButtonElement;

    // Prefilled with the balance; a reference is still required.
    expect(amount.value).toBe("600.00");
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Bank reference/), {
      target: { value: "TRX-2" },
    });
    fireEvent.change(amount, { target: { value: "700" } });
    expect(within(dialog).getByText("More than the balance.")).toBeTruthy();
    expect(confirm.disabled).toBe(true);

    fireEvent.change(amount, { target: { value: "250.50" } });
    fireEvent.change(within(dialog).getByLabelText("Received on"), {
      target: { value: "2026-10-21" },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(
        callsTo("/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments"),
      ).toHaveLength(1),
    );
    expect(
      callsTo("/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments")[0],
    ).toEqual({
      amountMinor: 25_050,
      receivedAt: "2026-10-21T12:00:00.000Z",
      bankReference: "TRX-2",
      note: null,
      receiptId: null,
      receiptStorageKey: null,
    });
    expect(await screen.findByText("Transfer recorded.")).toBeTruthy();
  });

  test("records a transfer from the school's receipt, which matches it", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Record from this receipt" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Bank reference/), {
      target: { value: "TRX-3" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record transfer" }));

    await waitFor(() =>
      expect(
        callsTo("/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments"),
      ).toHaveLength(1),
    );
    expect(
      callsTo("/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments")[0],
    ).toMatchObject({ amountMinor: 60_000, bankReference: "TRX-3", receiptId: RECEIPT_ID });
  });

  test("parses the amount in the currency's own minor units", async () => {
    current = invoice("KWD", 3);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Record a transfer" }));
    const dialog = await screen.findByRole("dialog");
    const amount = within(dialog).getByLabelText("Amount (KWD)") as HTMLInputElement;
    expect(amount.value).toBe("600.000");

    fireEvent.change(amount, { target: { value: "12.5" } });
    fireEvent.change(within(dialog).getByLabelText(/Bank reference/), {
      target: { value: "KW-1" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record transfer" }));

    await waitFor(() =>
      expect(
        callsTo("/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments"),
      ).toHaveLength(1),
    );
    expect(
      callsTo("/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments")[0],
    ).toMatchObject({ amountMinor: 12_500 });
  });

  test("matches a pending receipt to a recorded payment", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Match transfer.pdf to a payment" }));
    const dialog = await screen.findByRole("dialog", { name: "Match transfer.pdf" });
    const confirm = within(dialog).getByRole("button", {
      name: "Match to a payment",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("combobox", { name: "Payment" }));
    fireEvent.click(screen.getByRole("option", { name: /^TRX-1 · \$400\.00/ }));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(
        callsTo("/api/platform/schools/{schoolId}/license-receipts/{receiptId}/match"),
      ).toEqual([{ paymentId: PAYMENT_ID }]),
    );
    const [path, init] = postMock.mock.calls.find(
      ([called]) =>
        called === "/api/platform/schools/{schoolId}/license-receipts/{receiptId}/match",
    )!;
    expect(path).toBeTruthy();
    expect((init as { params: { path: unknown } }).params.path).toEqual({
      schoolId: SCHOOL_ID,
      receiptId: RECEIPT_ID,
    });
    expect(await screen.findByText("Receipt matched.")).toBeTruthy();
  });

  test("voids a payment only with a reason", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Void payment TRX-1" }));
    const dialog = await screen.findByRole("dialog", { name: "Void payment TRX-1" });
    const confirm = within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "Bounced transfer" },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(callsTo("/api/platform/schools/{schoolId}/license-payments/{paymentId}/void")).toEqual(
        [{ reason: "Bounced transfer" }],
      ),
    );
    expect(await screen.findByText("Voided.")).toBeTruthy();
  });
});
