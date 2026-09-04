import { expect, test } from "@playwright/test";

import { apiLoginAs, bearer, loginInBrowser } from "./support/auth";
import { PERSONAS } from "./support/personas";
import { API_BASE_URL } from "./support/ports";

// Mirrors db/seeds/e2e-critical-fixtures.ts's own constant — duplicated rather than imported across
// the apps/web ↔ db package boundary (that file isn't part of any workspace apps/web already depends
// on, and Playwright's spec files stay within this app's own module graph, same as every other
// support import here).
const E2E_SECOND_PLAN_CODE = "campus_enterprise_e2e";

/**
 * Journey 7/7: subscription checkout (test mode).
 *
 * Stripe is faked end to end (`FakeStripeProvider`, `apps/api/tests/e2e/server.ts`) rather than
 * hitting a real account — see the journey catalog for why. Everything else is real: the actual
 * `POST /api/subscriptions/school/checkout` route, the actual seat-counting and Stripe-customer
 * lazy-creation in `checkout-service.ts`, and the actual `POST /api/subscriptions/webhook/stripe`
 * route running `@studafy/billing`'s real state machine — only the network calls a genuine Stripe
 * account would otherwise need are swapped for the fake. `global-setup.ts`'s
 * `e2e-critical-fixtures.ts` step seeds a *second* plan first: the demo tenant's seeded subscription
 * is already on the only plan the main seed creates, so there would be nothing to switch to
 * otherwise (see that fixture's own header).
 */
test.describe("subscription checkout (test mode)", () => {
  test("an admin starts a plan checkout in the browser and the webhook confirms it", async ({
    page,
    request,
  }) => {
    const adminToken = await apiLoginAs(request, PERSONAS.orgAdmin);

    // Both plans need a Stripe price before checkout will accept them (checkout-service.ts refuses
    // an unsynced plan) — real endpoint, fake provider underneath.
    const syncRes = await request.post(`${API_BASE_URL}/api/admin/subscriptions/sync-prices`, {
      headers: bearer(adminToken),
    });
    expect(syncRes.ok()).toBe(true);

    const plansRes = await request.get(`${API_BASE_URL}/api/subscriptions/plans`);
    expect(plansRes.ok()).toBe(true);
    const plans = (await plansRes.json()) as { code: string; displayName: string }[];
    const targetPlan = plans.find((p) => p.code === E2E_SECOND_PLAN_CODE);
    if (!targetPlan) throw new Error(`expected the ${E2E_SECOND_PLAN_CODE} fixture plan to exist`);

    await loginInBrowser(page, PERSONAS.orgAdmin);
    await page.goto("/portal/billing");
    await page.getByRole("button", { name: "Change plan" }).click();
    await page.getByRole("radio", { name: new RegExp(targetPlan.displayName) }).check();

    const checkoutRequest = page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/subscriptions/school/checkout") &&
        res.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Continue to checkout" }).click();
    const checkoutResponse = await checkoutRequest;
    expect(checkoutResponse.status()).toBe(200);
    const { sessionId } = (await checkoutResponse.json()) as { sessionId: string; url: string };

    // The fake provider's checkout URL points straight back at this app's own success route (see
    // FakeStripeProvider's doc comment) — real Stripe would interpose its own hosted page first, but
    // landing here is still the honest post-checkout state: a session exists, nothing is paid for
    // yet. Confirmation is the webhook below, exactly as it is against real Stripe.
    await expect(page).toHaveURL(/checkout=success/, { timeout: 15_000 });

    const eventRes = await request.post(
      `${API_BASE_URL}/__e2e__/fake-stripe/checkout-completed-event`,
      { data: { sessionId } },
    );
    expect(eventRes.ok()).toBe(true);
    const event = await eventRes.json();

    const webhookRes = await request.post(`${API_BASE_URL}/api/subscriptions/webhook/stripe`, {
      data: event,
      headers: { "Stripe-Signature": "t=0,v1=fake-e2e-signature" },
    });
    expect(webhookRes.ok()).toBe(true);
    const webhookBody = (await webhookRes.json()) as { received: true; outcome: string };
    expect(webhookBody.received).toBe(true);
    expect(["processed", "duplicate"]).toContain(webhookBody.outcome);

    // Reload the billing overview — proof the webhook's write (state machine transition, audit row,
    // entitlement-change publish) left the school in a state the admin's own screen still renders
    // cleanly, not a page that starts erroring after a real webhook lands.
    await page.reload();
    await expect(page.getByRole("button", { name: "Change plan" })).toBeVisible();
  });
});
