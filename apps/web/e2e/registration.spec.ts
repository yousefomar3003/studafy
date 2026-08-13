import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * End-to-end coverage for the school self-registration flow (ST-184 AC: "e2e test covers full
 * flow"). Every backend call is stubbed via `page.route()` — `/api/lookups/*`,
 * `/api/schools/register`, `/api/schools/resend-verification` — so this runs against the Vite dev
 * server alone, with no Postgres, seeded reference data, or `apps/api` process required. A true
 * e2e run against a live backend is a heavier follow-up (real database, seeded countries/
 * currencies, Turnstile secret key) that is out of scope here; this still drives a real browser
 * through real DOM, focus, and navigation, which is what a component test cannot.
 *
 * Cloudflare's own `challenges.cloudflare.com/turnstile/v0/api.js` is stubbed too (see
 * `stubTurnstile` below), for the same reason the backend is: a CI-grade e2e suite should not
 * depend on a live third party's availability or its bot-detection deciding a headless, automated
 * browser is itself a bot — which is precisely what a real Turnstile challenge is designed to
 * catch, test sitekey or not. Confirmed against this suite: the real widget did not resolve within
 * 30s running headless here.
 */

const COUNTRIES = [
  { id: "11111111-1111-1111-1111-111111111111", alpha2_code: "US", name: "United States" },
];
const CURRENCIES = [{ id: "22222222-2222-2222-2222-222222222222", code: "USD", name: "US Dollar" }];

const REGISTER_RESPONSE = {
  school: {
    id: "33333333-3333-3333-3333-333333333333",
    slug: "springfield-academy",
    name: "Springfield Academy",
    status: "registered",
    created_at: "2026-08-13T00:00:00.000Z",
  },
  admin: {
    id: "44444444-4444-4444-4444-444444444444",
    email: "principal@springfield-academy.edu",
    role: "ORG_ADMIN",
  },
  invitation: { token: "inv-token", expires_at: "2026-08-20T00:00:00.000Z" },
  verification: { token: "ver-token", expires_at: "2026-08-14T00:00:00.000Z" },
};

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubLookups(page: Page) {
  await page.route("**/api/lookups/countries", (route) =>
    fulfillJson(route, 200, { countries: COUNTRIES }),
  );
  await page.route("**/api/lookups/currencies", (route) =>
    fulfillJson(route, 200, { currencies: CURRENCIES }),
  );
}

/**
 * Replaces Cloudflare's Turnstile script with a fake that renders nothing and calls back with a
 * token immediately — see the module docstring for why the real widget isn't used here.
 */
async function stubTurnstile(page: Page) {
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `window.turnstile = {
        render: (container, options) => {
          options.callback("fake-e2e-turnstile-token");
          return "fake-widget-id";
        },
        reset: () => {},
        remove: () => {},
      };`,
    }),
  );
}

async function fillSchoolDetailsStep(page: Page) {
  await page.getByLabel(/school name/i).fill("Springfield Academy");
  await page.getByLabel(/school contact email/i).fill("hello@springfield-academy.edu");

  await page.getByRole("combobox", { name: /^country/i }).click();
  await page.getByRole("option", { name: /united states/i }).click();

  await page.getByRole("combobox", { name: /^default currency/i }).click();
  await page.getByRole("option", { name: /us dollar/i }).click();

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: /administrator contact/i })).toBeVisible();
}

async function submitAdminContactStep(page: Page) {
  await page.getByLabel(/administrator email/i).fill("principal@springfield-academy.edu");
  await page.getByRole("button", { name: /create school account/i }).click();
}

test.describe("school registration", () => {
  test("completes the full flow: school details → admin contact → result → resend", async ({
    page,
  }) => {
    await stubLookups(page);
    await stubTurnstile(page);
    await page.route("**/api/schools/register", (route) =>
      fulfillJson(route, 201, REGISTER_RESPONSE),
    );
    await page.route("**/api/schools/resend-verification", (route) =>
      fulfillJson(route, 200, { message: "sent" }),
    );

    await page.goto("/onboarding");

    await fillSchoolDetailsStep(page);
    await submitAdminContactStep(page);

    await expect(
      page.getByRole("heading", { name: /springfield academy is registered/i }),
    ).toBeVisible();
    await expect(page.getByText("hello@springfield-academy.edu")).toBeVisible();
    await expect(page.getByText("principal@springfield-academy.edu")).toBeVisible();

    const resendRequest = page.waitForRequest("**/api/schools/resend-verification");
    await page.getByRole("button", { name: /resend verification email/i }).click();
    await resendRequest;
  });

  test("inline-validates the school email before any request is sent", async ({ page }) => {
    await stubLookups(page);
    let registerCalled = false;
    await page.route("**/api/schools/register", (route) => {
      registerCalled = true;
      return fulfillJson(route, 201, REGISTER_RESPONSE);
    });

    await page.goto("/onboarding");

    await page.getByLabel(/school name/i).fill("Springfield Academy");
    await page.getByLabel(/school contact email/i).fill("not-an-email");
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.getByText(/enter a valid email address/i)).toBeVisible();
    expect(registerCalled).toBe(false);
  });

  test("a duplicate slug returns the user to step 1 with an inline field error", async ({
    page,
  }) => {
    await stubLookups(page);
    await stubTurnstile(page);
    await page.route("**/api/schools/register", (route) =>
      fulfillJson(route, 409, {
        type: "about:blank",
        title: "Conflict",
        status: 409,
        code: "SCHOOL_SLUG_DUPLICATE",
        detail: "This school slug is already taken.",
        request_id: "00000000-0000-0000-0000-000000000000",
      }),
    );

    await page.goto("/onboarding");
    await fillSchoolDetailsStep(page);
    await submitAdminContactStep(page);

    await expect(page.getByRole("heading", { name: /school details/i })).toBeVisible();
    await expect(page.getByText(/already taken/i)).toBeVisible();
  });
});
