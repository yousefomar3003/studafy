import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { renderAs } from "./test-utils";

import type { ComponentType } from "react";

/**
 * One license invoice on the school's side: lines, due date and balance; the bank details and the
 * payment reference with a copy button; uploading a transfer receipt (pre-signed upload, then the
 * receipt is attached to the invoice); each receipt's status; and no upload without license:manage.
 */

const INVOICE_ID = "11111111-1111-4111-8111-111111111111";

const invoice = {
  id: INVOICE_ID,
  schoolId: "s-1",
  licenseId: "l-1",
  quoteId: null,
  number: "LIC-2026-000042",
  paymentReference: "STF-AB12-CD34",
  status: "partially_paid",
  currencyCode: "USD",
  minorUnit: 2,
  issueDate: "2026-10-01",
  dueDate: "2026-10-31",
  subtotalMinor: 100_000,
  creditTotalMinor: 0,
  adjustmentMinor: 0,
  totalMinor: 100_000,
  paidMinor: 40_000,
  balanceMinor: 60_000,
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
    currencyCode: "USD",
  },
  lines: [
    {
      position: 1,
      kind: "seats",
      audience: "student",
      description: "Student Plus: 100 student seats, 12 months",
      amountMinor: 100_000,
    },
  ],
  payments: [
    {
      id: "p-1",
      invoiceId: INVOICE_ID,
      amountMinor: 40_000,
      currencyCode: "USD",
      receivedAt: "2026-10-05T12:00:00.000Z",
      bankReference: "TRX-1",
      method: "bank_transfer",
      note: null,
      hasReceiptFile: false,
      recordedBy: "u-1",
      createdAt: "2026-10-05T12:00:00.000Z",
      voidedAt: null,
      voidReason: null,
    },
  ],
  receipts: [
    {
      id: "r-1",
      invoiceId: INVOICE_ID,
      fileName: "first-transfer.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
      note: null,
      status: "matched",
      paymentId: "p-1",
      matchedAt: "2026-10-06T00:00:00.000Z",
      uploadedBy: "u-2",
      createdAt: "2026-10-05T09:00:00.000Z",
    },
    {
      id: "r-2",
      invoiceId: INVOICE_ID,
      fileName: "second-transfer.png",
      contentType: "image/png",
      sizeBytes: 4096,
      note: "Second instalment",
      status: "pending",
      paymentId: null,
      matchedAt: null,
      uploadedBy: "u-2",
      createdAt: "2026-10-20T09:00:00.000Z",
    },
  ],
};

const UPLOAD = {
  upload_url: "https://storage.example.com/temp/school-1/receipt.pdf",
  storage_key: "temp/school-1/abc/receipt.pdf",
  expires_at: "2026-10-27T12:00:00.000Z",
};

const getMock = mock((path: string) => {
  if (path === "/api/school/license/invoices/{invoiceId}")
    return Promise.resolve({ data: invoice });
  if (path === "/api/school/license") {
    return Promise.resolve({ data: { license: null, usage: [], openChangeRequests: [] } });
  }
  if (path === "/api/school/license/invoices") {
    return Promise.resolve({ data: { invoices: [], status: "overdue" } });
  }
  throw new Error(`Unhandled GET ${path}`);
});
const postMock = mock((path: string, _init?: { body?: Record<string, unknown> }) => {
  if (path === "/api/storage/uploads/request-upload") return Promise.resolve({ data: UPLOAD });
  if (path === "/api/school/license/invoices/{invoiceId}/receipts") {
    return Promise.resolve({ data: { ...invoice.receipts[1], id: "r-3", status: "pending" } });
  }
  throw new Error(`Unhandled POST ${path}`);
});
mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const fetchMock = mock((_url: string, _init?: RequestInit) =>
  Promise.resolve(new Response(null, { status: 200 })),
);
const writeText = mock((_text: string) => Promise.resolve());
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  getMock.mockClear();
  postMock.mockClear();
  fetchMock.mockClear();
  writeText.mockClear();
});

const loadPage = async (): Promise<ComponentType> => (await import("./InvoiceDetailPage")).default;

async function renderPage(role = "PRINCIPAL") {
  const Page = await loadPage();
  return renderAs(role, <Page />, {
    path: "/portal/license/invoices/:invoiceId",
    at: `/portal/license/invoices/${INVOICE_ID}`,
  });
}

function chooseFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe("InvoiceDetailPage", () => {
  test("shows the lines, due date, balance and how to pay", async () => {
    await renderPage();
    expect(
      await screen.findByRole("heading", { name: "Invoice LIC-2026-000042", level: 1 }),
    ).toBeTruthy();
    expect(screen.getByText("Student Plus: 100 student seats, 12 months")).toBeTruthy();
    expect(screen.getByText("Oct 31, 2026")).toBeTruthy();
    const balance = screen.getByText("Balance", { selector: "dt" }).parentElement!;
    expect(within(balance).getByText("$600.00")).toBeTruthy();

    const pay = within(screen.getByRole("region", { name: "How to pay" }));
    expect(
      pay.getByText(
        "Transfer $600.00 to the account below and write the payment reference on the transfer.",
      ),
    ).toBeTruthy();
    expect(pay.getByText("STF-AB12-CD34")).toBeTruthy();
    expect(pay.getByText("AE070331234567890123456")).toBeTruthy();
    expect(pay.getByText("GULFAEAD")).toBeTruthy();
  });

  test("copies the payment reference", async () => {
    await renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy payment reference STF-AB12-CD34" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("STF-AB12-CD34"));
    expect(await screen.findByText("Payment reference copied.")).toBeTruthy();
  });

  test("shows each receipt's status", async () => {
    await renderPage();
    const receipts = within(await screen.findByRole("table", { name: "Transfer receipts" }));
    const row = (file: string) => receipts.getByText(file).closest("tr")!;
    expect(within(row("first-transfer.pdf")).getByText("Matched to a payment")).toBeTruthy();
    expect(within(row("second-transfer.png")).getByText("Waiting for Studafy")).toBeTruthy();
    expect(within(row("second-transfer.png")).getByText("Second instalment")).toBeTruthy();
  });

  test("uploads a receipt: pre-signed upload, then attached to the invoice", async () => {
    await renderPage();
    const upload = within(await screen.findByRole("group", { name: "Upload a transfer receipt" }));
    const button = upload.getByRole("button", { name: "Upload receipt" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const file = new File(["%PDF-1.4 receipt"], "receipt.pdf", { type: "application/pdf" });
    chooseFile(file);
    fireEvent.change(upload.getByLabelText("Note (optional)"), {
      target: { value: "Third instalment" },
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    const [uploadPath, uploadInit] = postMock.mock.calls[0]!;
    expect(uploadPath).toBe("/api/storage/uploads/request-upload");
    expect(uploadInit!.body).toEqual({
      content_class: "license.receipt",
      file_name: "receipt.pdf",
      content_type: "application/pdf",
      size_bytes: file.size,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [putUrl, putInit] = fetchMock.mock.calls[0]!;
    expect(putUrl).toBe(UPLOAD.upload_url);
    expect(putInit!.method).toBe("PUT");

    const [receiptPath, receiptInit] = postMock.mock.calls[1]!;
    expect(receiptPath).toBe("/api/school/license/invoices/{invoiceId}/receipts");
    expect(receiptInit!.body).toEqual({
      storageKey: UPLOAD.storage_key,
      note: "Third instalment",
    });
    expect(
      await screen.findByText("Receipt uploaded. Studafy will match it to your payment."),
    ).toBeTruthy();
  });

  test("refuses a file the receipt class does not take, before uploading", async () => {
    await renderPage();
    const upload = within(await screen.findByRole("group", { name: "Upload a transfer receipt" }));
    chooseFile(new File(["x"], "receipt.docx", { type: "application/msword" }));
    expect(upload.getByRole("alert").textContent).toBe("Upload a PDF, JPEG or PNG.");
    expect(
      (upload.getByRole("button", { name: "Upload receipt" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(postMock).not.toHaveBeenCalled();
  });

  test("without license:manage there is no upload, but the receipts and reference show", async () => {
    await renderPage("FINANCE");
    await screen.findByRole("table", { name: "Transfer receipts" });
    expect(screen.queryByRole("group", { name: "Upload a transfer receipt" })).toBeNull();
    expect(screen.getByText("STF-AB12-CD34")).toBeTruthy();
    expect(screen.getByText("Waiting for Studafy")).toBeTruthy();
  });
});
