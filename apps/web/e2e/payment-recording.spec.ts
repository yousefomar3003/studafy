import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * End-to-end coverage for payment recording: invoice lookup, the live partial-payment math, and
 * the success state's receipt — against a stubbed backend, the same approach as
 * `discipline-management.spec.ts`, no Postgres or `apps/api` process required.
 *
 * The one thing this suite exists specifically to prove that a component test cannot: that a real
 * double-click on the submit button — two genuine browser click events, not two synthetic calls to
 * the same handler — still records exactly one payment. `RecordPaymentPage.test.tsx` covers the same
 * guard with `fireEvent`, which is enough to pin the logic down, but `dblclick()` here is what
 * actually exercises the browser event sequence the acceptance criterion is about.
 */

const NOW = "2026-08-21T00:00:00.000Z";
const PAYMENT_ID = "payment-1";

function fakeAccessToken(roles: string[]): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256" })}.${segment({ sub: "finance-1", roles })}.signature`;
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** Whatever else the portal shell fetches on mount — see `user-management.spec.ts` for why this must
 * be registered before every more specific handler below. */
async function stubPortalShellDefaults(page: Page) {
  await page.route("**/api/**", (route) => fulfillJson(route, 200, {}));
}

async function stubAuthenticatedSession(page: Page) {
  await page.route("**/api/auth/refresh", (route) =>
    fulfillJson(route, 200, {
      access_token: fakeAccessToken(["FINANCE"]),
      expires_in: 3600,
      session_id: "session-1",
    }),
  );
}

function buildInvoice() {
  return {
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
    last_synced_at: NOW,
  };
}

function buildPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
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
    last_synced_at: NOW,
    ...overrides,
  };
}

const CONFIRMED_PAYMENT = buildPayment({
  status: "confirmed",
  erpnext_status: "Submitted",
  receipt_url: "https://erpnext.example.com/receipts/payment-1",
  confirmed_at: "2026-08-21T00:01:00.000Z",
});

/**
 * Stubs `GET /api/finance/invoices` (lookup), `POST /api/finance/payments` (record, counting
 * calls), and `GET /api/finance/payments/{id}` (the success state's confirmation poll, which
 * always answers already-confirmed — this suite is about the double-click guard and the receipt
 * link appearing, not the 3s polling interval itself).
 */
async function stubPaymentsBackend(page: Page) {
  const pathIs = (url: string, pathname: string) => new URL(url).pathname === pathname;
  let createCalls = 0;

  await page.route("**/api/finance/invoices**", async (route) => {
    const url = route.request().url();
    if (pathIs(url, "/api/finance/invoices") && route.request().method() === "GET") {
      return fulfillJson(route, 200, { invoices: [buildInvoice()], next_cursor: null });
    }
    return route.fallback();
  });

  await page.route("**/api/finance/payments**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (pathIs(url, "/api/finance/payments") && method === "POST") {
      createCalls += 1;
      return fulfillJson(route, 201, buildPayment());
    }

    if (pathIs(url, `/api/finance/payments/${PAYMENT_ID}`) && method === "GET") {
      return fulfillJson(route, 200, CONFIRMED_PAYMENT);
    }

    return route.fallback();
  });

  return {
    createCallCount: () => createCalls,
  };
}

async function fillPaymentForm(page: Page) {
  await page.getByLabel("Invoice", { exact: false }).fill("Layla");
  await page.getByRole("button", { name: /ACC-SINV-2026-00001/ }).click();
  await page.getByLabel("Amount", { exact: false }).fill("500");
  await page.getByRole("radio", { name: "Cash" }).check();
}

test.describe("payment recording", () => {
  test("looks up an invoice, shows live partial-payment math, and opens the receipt from the success state", async ({
    page,
  }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    await stubPaymentsBackend(page);

    await page.goto("/portal/finance/payments/new");
    await expect(page.getByRole("heading", { name: "Record a payment" })).toBeVisible();

    await fillPaymentForm(page);

    await expect(
      page.getByText("Partial payment — 500.000 JOD will remain outstanding."),
    ).toBeVisible();

    const createRequest = page.waitForRequest(
      (req) => req.url().includes("/api/finance/payments") && req.method() === "POST",
    );
    await page.getByRole("button", { name: "Record payment" }).click();
    const request = await createRequest;
    expect(request.headers()["idempotency-key"]).toBeTruthy();
    expect(request.postDataJSON()).toMatchObject({
      student_id: "student-1",
      invoice_id: "ACC-SINV-2026-00001",
      amount: 500,
      payment_mode: "cash",
      currency: "JOD",
    });

    await expect(page.getByText("Payment recorded — 500 JOD")).toBeVisible();

    const receiptLink = page.getByRole("link", { name: "Open receipt" });
    await expect(receiptLink).toBeVisible();
    await expect(receiptLink).toHaveAttribute(
      "href",
      "https://erpnext.example.com/receipts/payment-1",
    );
  });

  test("double-clicking submit does not double-record the payment", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    const backend = await stubPaymentsBackend(page);

    await page.goto("/portal/finance/payments/new");
    await expect(page.getByRole("heading", { name: "Record a payment" })).toBeVisible();

    await fillPaymentForm(page);

    // A real double-click: two genuine click events on the same button, not two calls into the
    // same handler — see the suite's own doc comment for why this can't be a component test.
    await page.getByRole("button", { name: "Record payment" }).dblclick();

    await expect(page.getByText("Payment recorded — 500 JOD")).toBeVisible();
    expect(backend.createCallCount()).toBe(1);
  });
});
