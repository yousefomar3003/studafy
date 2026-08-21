import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * End-to-end coverage for the scholarship award and refund flows, against a stubbed backend — same
 * approach as `payment-recording.spec.ts`, no Postgres or `apps/api` process required. Covers what a
 * component test cannot: the maker form's confirmation dialog and the checker's confirm action, each
 * driven by real browser click events against the actual rendered DOM.
 */

const NOW = "2026-08-21T00:00:00.000Z";

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

function buildStudent() {
  return { id: "student-1", first_name: "Layla", last_name: "Haddad", admission_number: "ADM-001" };
}

function buildDiscount() {
  return {
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
    last_synced_at: NOW,
  };
}

function buildAward(overrides: Record<string, unknown> = {}) {
  return {
    id: "award-1",
    school_id: "school-1",
    student_id: "student-1",
    scholarship_discount_id: "discount-1",
    scholarship_discount_title: "Sibling discount",
    award_status: "pending",
    awarded_by: "someone-else",
    confirmed_by: null,
    confirmed_at: null,
    erpnext_docname: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
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
    outstanding_amount: "400.000",
    outstanding_amount_minor: 400000,
    currency: "JOD",
    currency_minor_unit: 3,
    issued_date: "2026-08-01",
    due_date: "2026-09-01",
    last_synced_at: NOW,
  };
}

function buildRefund(overrides: Record<string, unknown> = {}) {
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
    maker_id: "finance-1",
    checker_id: null,
    approved_at: null,
    completed_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function stubScholarshipBackend(page: Page) {
  const pathIs = (url: string, pathname: string) => new URL(url).pathname === pathname;
  let createCalls = 0;
  let confirmCalls = 0;

  await page.route("**/api/students**", (route) =>
    fulfillJson(route, 200, { students: [buildStudent()], total: 1 }),
  );

  await page.route("**/api/finance/scholarship-discounts**", async (route) => {
    const url = route.request().url();
    if (pathIs(url, "/api/finance/scholarship-discounts/awards")) {
      if (route.request().method() === "POST") {
        createCalls += 1;
        return fulfillJson(route, 201, buildAward());
      }
      return fulfillJson(route, 200, { awards: [buildAward()], total: 1 });
    }
    if (url.endsWith("/confirm") && route.request().method() === "POST") {
      confirmCalls += 1;
      return fulfillJson(route, 200, buildAward({ award_status: "confirmed" }));
    }
    if (pathIs(url, "/api/finance/scholarship-discounts")) {
      return fulfillJson(route, 200, { scholarship_discounts: [buildDiscount()], total: 1 });
    }
    return route.fallback();
  });

  return { createCallCount: () => createCalls, confirmCallCount: () => confirmCalls };
}

async function stubRefundBackend(page: Page) {
  const pathIs = (url: string, pathname: string) => new URL(url).pathname === pathname;
  let initiateCalls = 0;

  await page.route("**/api/finance/invoices**", async (route) => {
    const url = route.request().url();
    if (pathIs(url, "/api/finance/invoices") && route.request().method() === "GET") {
      return fulfillJson(route, 200, { invoices: [buildInvoice()], next_cursor: null });
    }
    return route.fallback();
  });

  await page.route("**/api/finance/refunds**", async (route) => {
    const url = route.request().url();
    if (pathIs(url, "/api/finance/refunds/initiate") && route.request().method() === "POST") {
      initiateCalls += 1;
      return fulfillJson(route, 201, buildRefund());
    }
    return route.fallback();
  });

  return { initiateCallCount: () => initiateCalls };
}

test.describe("scholarship award", () => {
  test("awards a scholarship, showing the computed effect before it commits", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    const backend = await stubScholarshipBackend(page);

    await page.goto("/portal/finance/adjustments/scholarships/new");
    await expect(
      page.getByRole("heading", { name: "Award a scholarship or discount" }),
    ).toBeVisible();

    await page.getByLabel("Student", { exact: false }).fill("Layla");
    await page.getByRole("button", { name: /Layla Haddad/ }).click();

    await page.getByRole("combobox", { name: "Scholarship / discount" }).click();
    await page.getByRole("option", { name: "Sibling discount" }).click();
    await expect(
      page.getByText("50 JOD off all fee categories on every future invoice."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Review award" }).click();

    const dialog = page.getByRole("dialog", { name: "Award scholarship?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Sibling discount")).toBeVisible();

    const createRequest = page.waitForRequest(
      (req) =>
        req.url().includes("/api/finance/scholarship-discounts/awards") && req.method() === "POST",
    );
    await dialog.getByRole("button", { name: "Create award" }).click();
    await createRequest;

    await expect(page.getByText("Award created — Sibling discount")).toBeVisible();
    expect(backend.createCallCount()).toBe(1);
  });

  test("confirming a pending award (the checker step) forwards it", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    const backend = await stubScholarshipBackend(page);

    await page.goto("/portal/finance/adjustments/scholarships");
    await expect(page.getByText("Sibling discount")).toBeVisible();

    await page.getByRole("button", { name: "Confirm" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm scholarship award?" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Confirm award" }).click();
    await expect(page.getByText("Award confirmed")).toBeVisible();
    expect(backend.confirmCallCount()).toBe(1);
  });
});

test.describe("refund", () => {
  test("blocks a refund that exceeds the invoice's paid amount, then requests one within the cap", async ({
    page,
  }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    const backend = await stubRefundBackend(page);

    await page.goto("/portal/finance/adjustments/refunds/new");
    await expect(page.getByRole("heading", { name: "Request a refund" })).toBeVisible();

    await page.getByLabel("Invoice", { exact: false }).fill("Layla");
    await page.getByRole("button", { name: /ACC-SINV-2026-00001/ }).click();

    // Paid to date = total (1000.000) - outstanding (400.000) = 600.000.
    await page.getByLabel("Amount", { exact: false }).fill("700");
    await expect(
      page.getByText(
        "This exceeds the paid amount on this invoice (600.000 JOD). Reduce the amount to continue.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Review refund" })).toBeDisabled();

    await page.getByLabel("Amount", { exact: false }).fill("100");
    await page.getByRole("combobox", { name: "Reason" }).click();
    await page.getByRole("option", { name: "Overpayment" }).click();
    await page.getByRole("button", { name: "Review refund" }).click();

    const dialog = page.getByRole("dialog", { name: "Request refund?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("100.000 JOD")).toBeVisible();

    const initiateRequest = page.waitForRequest(
      (req) => req.url().includes("/api/finance/refunds/initiate") && req.method() === "POST",
    );
    await dialog.getByRole("button", { name: "Request refund" }).click();
    const request = await initiateRequest;
    expect(request.headers()["idempotency-key"]).toBeTruthy();
    expect(request.postDataJSON()).toMatchObject({
      student_id: "student-1",
      erpnext_invoice_id: "ACC-SINV-2026-00001",
      amount: 100,
      currency: "JOD",
      reason_code: "overpayment",
    });

    await expect(page.getByText("Refund requested — 100.000 JOD")).toBeVisible();
    expect(backend.initiateCallCount()).toBe(1);
  });
});
