import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { apiActivateAndLoginAs, apiLoginAs, bearer, loginInBrowser } from "./support/auth";
import { API_BASE_URL } from "./support/ports";

const PROVISIONING_TIMEOUT_MS = 60_000;
const INVOICE_BATCH_TIMEOUT_MS = 60_000;

/**
 * Journey 5/7: invoice → payment.
 *
 * Runs against the real ERPNext sandbox configured in this environment (`ERPNEXT_API_URL`/
 * `ERPNEXT_API_KEY` — confirmed a disposable target safe for repeated automated writes, unlike the
 * AI and Stripe dependencies this suite fakes; see the journey catalog). The pre-seeded demo tenant
 * cannot be reused here: its finance rows are local read-model fixtures with fabricated ERPNext
 * docnames (`db/seeds/data/finance.ts`'s own header), never actually created on ERPNext, so this
 * spec registers and verifies its own school first — real tenant provisioning against the sandbox,
 * the same code path the registration journey exercises — and only proceeds once that finishes.
 *
 * Fee structure creation, invoice batch generation, and payment recording all have real web UI
 * (FeeStructureBuilderPage, InvoiceBatchPage, RecordPaymentPage); this spec drives fee structure and
 * batch creation through the API (the setup this journey needs, not what it is testing) and the
 * browser through the one step the ticket names explicitly: recording a payment.
 */
test.describe("invoice → payment", () => {
  test("an admin generates an invoice and records a payment against a live ERPNext sandbox", async ({
    page,
    request,
  }) => {
    const unique = randomUUID().slice(0, 8);
    const registerRes = await request.post(`${API_BASE_URL}/api/schools/register`, {
      data: {
        school_name: `E2E Billing Academy ${unique}`,
        slug: `e2e-billing-academy-${unique}`,
        email: `hello+${unique}@e2e-billing.test`,
        admin_email: `admin+${unique}@e2e-billing.test`,
        // Same US country/currency the registration journey uses — both real, migration-000005 seed.
        country_id: await lookupId(request, "countries", "alpha2_code", "US"),
        default_currency_id: await lookupId(request, "currencies", "code", "USD"),
        // Verification is skipped server-side when TURNSTILE_SECRET_KEY is unset (registration/
        // service.ts) — true for this suite's E2E API process — so any non-empty value satisfies
        // the schema without a real Turnstile round trip.
        captcha_token: "e2e-fake-token",
      },
    });
    expect(registerRes.ok()).toBe(true);
    const registered = (await registerRes.json()) as {
      school: { id: string };
      admin: { email: string };
      invitation: { token: string };
      verification: { token: string };
    };

    const verifyRes = await request.get(
      `${API_BASE_URL}/api/schools/verify-email/${registered.verification.token}`,
    );
    expect(verifyRes.ok()).toBe(true);

    const adminToken = await apiActivateAndLoginAs(
      request,
      registered.invitation.token,
      registered.admin.email,
    );

    // Verification triggers ERPNext bootstrap asynchronously (tenancy/verification/route.ts's
    // "fire-and-forget" provisioning) — poll until it actually finishes rather than assuming it has
    // by the time verify-email's response returns.
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${API_BASE_URL}/api/schools/${registered.school.id}/provisioning-status`,
            { headers: bearer(adminToken) },
          );
          if (!res.ok()) return "pending";
          const body = (await res.json()) as { status: string };
          return body.status;
        },
        { timeout: PROVISIONING_TIMEOUT_MS, message: "ERPNext provisioning never completed" },
      )
      .toBe("completed");

    // A single tuition line, in the school's own default currency. "Tuition" is ERPNext's own
    // standard Fee Category name — present in a stock install without further setup — not something
    // this suite provisions itself; see the file header if this needs adjusting against the actual
    // sandbox's configuration.
    const feeStructureRes = await request.post(`${API_BASE_URL}/api/finance/fee-structures`, {
      headers: bearer(adminToken),
      data: {
        title: `E2E Tuition ${unique}`,
        currency: "USD",
        components: [{ fee_category: "Tuition", amount: 500 }],
      },
    });
    expect(feeStructureRes.ok()).toBe(true);
    const feeStructure = (await feeStructureRes.json()) as { erpnext_name: string };

    const batchRes = await request.post(`${API_BASE_URL}/api/finance/invoices/batches`, {
      headers: bearer(adminToken),
      data: {
        fee_structure_erpnext_name: feeStructure.erpnext_name,
        period_title: `E2E Term ${unique}`,
      },
    });
    expect(batchRes.ok()).toBe(true);
    const batch = (await batchRes.json()) as { id: string };

    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${API_BASE_URL}/api/finance/invoices/batches/${batch.id}`,
            { headers: bearer(adminToken) },
          );
          const body = (await res.json()) as { status: string };
          return body.status;
        },
        { timeout: INVOICE_BATCH_TIMEOUT_MS, message: "invoice batch never completed" },
      )
      .toBe("completed");

    const itemsRes = await request.get(
      `${API_BASE_URL}/api/finance/invoices/batches/${batch.id}/items`,
      { headers: bearer(adminToken) },
    );
    expect(itemsRes.ok()).toBe(true);
    const { items } = (await itemsRes.json()) as {
      items: { student_id: string; erpnext_docname: string | null; status: string }[];
    };
    const succeeded = items.find((item) => item.status === "succeeded" && item.erpnext_docname);
    if (!succeeded?.erpnext_docname) {
      throw new Error("expected at least one succeeded invoice batch item");
    }
    const invoiceDocname = succeeded.erpnext_docname;

    // The browser-driven step: recording a payment against the real invoice ERPNext just created.
    await loginInBrowser(page, registered.admin.email);
    await page.goto("/portal/finance/payments/new");
    await page.getByLabel("Invoice").fill(invoiceDocname);
    await page.getByRole("button", { name: invoiceDocname, exact: false }).first().click();
    await page.getByLabel("Amount").fill("500");
    await page.getByRole("radio", { name: "Cash" }).check();

    const paymentRequest = page.waitForResponse(
      (res) => res.url().endsWith("/api/finance/payments") && res.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Record payment" }).click();
    const paymentResponse = await paymentRequest;
    expect([200, 201]).toContain(paymentResponse.status());
    expect(paymentResponse.request().headers()["idempotency-key"]).toBeTruthy();

    const paymentBody = (await paymentResponse.json()) as {
      erpnext_invoice_id: string;
      amount: number;
      status: string;
    };
    expect(paymentBody.erpnext_invoice_id).toBe(invoiceDocname);
    expect(paymentBody.amount).toBe(500);
  });
});

async function lookupId(
  request: Parameters<typeof apiLoginAs>[0],
  resource: "countries" | "currencies",
  field: string,
  value: string,
): Promise<string> {
  const res = await request.get(`${API_BASE_URL}/api/lookups/${resource}`);
  if (!res.ok()) throw new Error(`GET /api/lookups/${resource} failed: ${res.status()}`);
  const body = (await res.json()) as Record<string, { id: string; [key: string]: unknown }[]>;
  const rows = body[resource];
  const match = rows.find((row) => row[field] === value);
  if (!match) throw new Error(`no ${resource} row with ${field}=${value}`);
  return match.id;
}
