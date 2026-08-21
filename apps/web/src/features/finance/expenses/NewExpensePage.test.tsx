import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

const CREATED_EXPENSE = {
  id: "expense-1",
  school_id: "school-1",
  document_type: "purchase_invoice",
  category: "Office Supplies",
  vendor: "Amman Stationery Co.",
  description: null,
  amount: "42.500",
  amount_minor: 42500,
  currency: "JOD",
  currency_minor_unit: 3,
  erpnext_name: "PINV-0001",
  erpnext_status: "draft",
  attachment_url: null,
  expense_date: "2026-08-21",
  last_synced_at: "2026-08-21T00:00:00.000Z",
};

const UPLOAD_URL_RESPONSE = {
  upload_url: "https://storage.example.com/temp/school-1/receipt-object-id/receipt.pdf",
  storage_key: "temp/school-1/receipt-object-id/receipt.pdf",
  expires_at: "2026-08-21T01:00:00.000Z",
};

let createExpenseCalls = 0;
let uploadUrlCalls = 0;
const postMock = mock((path: string, init?: { body: Record<string, unknown> }) => {
  if (path === "/api/finance/expenses/upload-url") {
    uploadUrlCalls += 1;
    return Promise.resolve({ data: UPLOAD_URL_RESPONSE });
  }
  if (path === "/api/finance/expenses") {
    createExpenseCalls += 1;
    return Promise.resolve({ data: { ...CREATED_EXPENSE, attachment_storage_key: init?.body } });
  }
  return Promise.resolve({ data: undefined });
});
mock.module("../../../lib/api", () => ({
  api: { GET: mock(() => Promise.resolve({ data: undefined })), POST: postMock },
}));

const originalFetch = globalThis.fetch;
const fetchMock = mock((_url: string, _init?: RequestInit) =>
  Promise.resolve(new Response(null, { status: 200 })),
);

const loadPage = async (): Promise<ComponentType> => (await import("./NewExpensePage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/portal/finance/expenses/new"]}>
          <Page />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** `Select` is a custom listbox, not a native `<select>` — same click-open-then-click-option
 * interaction `NewRefundPage.test.tsx`'s own reason picker uses. */
function pickDocumentType(label: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Document type" }));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

async function fillOutForm() {
  pickDocumentType("Purchase invoice");
  fireEvent.change(screen.getByLabelText("Expense account", { exact: false }), {
    target: { value: "Office Supplies" },
  });
  fireEvent.change(screen.getByLabelText("Supplier", { exact: false }), {
    target: { value: "Amman Stationery Co." },
  });
  fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
    target: { value: "42.5" },
  });
}

afterEach(() => {
  cleanup();
  postMock.mockClear();
  fetchMock.mockClear();
  createExpenseCalls = 0;
  uploadUrlCalls = 0;
  globalThis.fetch = originalFetch;
});

describe("NewExpensePage", () => {
  test("records an expense with no attachment", async () => {
    renderPage(await loadPage());
    await screen.findByRole("heading", { name: "Record an expense" });

    await fillOutForm();
    fireEvent.click(screen.getByRole("button", { name: "Record expense" }));

    expect(await screen.findByText("Expense recorded — 42.500 JOD")).toBeTruthy();
    expect(uploadUrlCalls).toBe(0);
    expect(createExpenseCalls).toBe(1);

    const [, init] = postMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(init.body).toEqual({
      document_type: "purchase_invoice",
      category: "Office Supplies",
      vendor: "Amman Stationery Co.",
      amount: 42.5,
      currency: "JOD",
      description: undefined,
      expense_date: undefined,
      attachment_storage_key: undefined,
    });
  });

  test("uploads a receipt through the pre-signed flow before creating the expense", async () => {
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderPage(await loadPage());
    await screen.findByRole("heading", { name: "Record an expense" });

    await fillOutForm();

    const file = new File(["%PDF-1.4 fake receipt"], "receipt.pdf", { type: "application/pdf" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    await screen.findByText("receipt.pdf");

    fireEvent.click(screen.getByRole("button", { name: "Record expense" }));

    expect(await screen.findByText("Expense recorded — 42.500 JOD")).toBeTruthy();

    expect(uploadUrlCalls).toBe(1);
    const [, uploadInit] = postMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(uploadInit.body).toEqual({ file_name: "receipt.pdf", content_type: "application/pdf" });

    expect(fetchMock.mock.calls.length).toBe(1);
    const [fetchUrl, fetchInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toBe(UPLOAD_URL_RESPONSE.upload_url);
    expect(fetchInit.method).toBe("PUT");

    const [, createInit] = postMock.mock.calls[1] as [string, { body: Record<string, unknown> }];
    expect(createInit.body).toMatchObject({
      attachment_storage_key: UPLOAD_URL_RESPONSE.storage_key,
    });
  });

  test("Record expense is disabled until the required fields are filled", async () => {
    renderPage(await loadPage());
    await screen.findByRole("heading", { name: "Record an expense" });

    expect(screen.getByRole("button", { name: "Record expense" }).hasAttribute("disabled")).toBe(
      true,
    );

    await fillOutForm();

    expect(screen.getByRole("button", { name: "Record expense" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  test("rejects a currency that isn't a 3-letter code", async () => {
    renderPage(await loadPage());
    await screen.findByRole("heading", { name: "Record an expense" });

    await fillOutForm();
    fireEvent.change(screen.getByLabelText("Currency", { exact: false }), {
      target: { value: "J" },
    });

    expect(await screen.findByText("Use a 3-letter currency code.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record expense" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});
