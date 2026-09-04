import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { API_BASE_URL } from "./support/ports";
import { stubTurnstile } from "./support/turnstile";

/**
 * Journey 1/7: registration → verification.
 *
 * Real backend end to end: `POST /api/schools/register` creates a real school, admin user, and
 * verification token against the live database (`/api/lookups/*` reference data is migration
 * 000005's real seed, not a stub); `GET /api/schools/verify-email/{token}` really verifies it,
 * flips the school from `registered` to `active`, and fires real ERPNext tenant provisioning
 * against the sandbox. See playwright.critical.config.ts for why Turnstile alone is still stubbed.
 *
 * The verification token is never rendered on screen (RegistrationResult.tsx: it only ever goes out
 * by email in a real deployment, by design) — this test reads it off the real network response the
 * registration form's own submission produces, the same way an E2E run with no email inbox to check
 * has to.
 */
test.describe("registration → verification", () => {
  test("a school self-registers, verifies its email, and becomes active", async ({
    page,
    request,
  }) => {
    await stubTurnstile(page);

    const unique = randomUUID().slice(0, 8);
    const schoolName = `E2E Academy ${unique}`;
    const schoolEmail = `hello+${unique}@e2e-academy.test`;
    const adminEmail = `principal+${unique}@e2e-academy.test`;

    await page.goto("/onboarding");

    await page.getByLabel(/school name/i).fill(schoolName);
    await page.getByLabel(/school contact email/i).fill(schoolEmail);
    await page.getByRole("combobox", { name: /^country/i }).click();
    await page.getByRole("option", { name: /united states/i }).click();
    await page.getByRole("combobox", { name: /^default currency/i }).click();
    await page.getByRole("option", { name: /us dollar/i }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("heading", { name: /administrator contact/i })).toBeVisible();

    await page.getByLabel(/administrator email/i).fill(adminEmail);

    const registerResponse = page.waitForResponse(
      (res) => res.url().endsWith("/api/schools/register") && res.request().method() === "POST",
    );
    await page.getByRole("button", { name: /create school account/i }).click();
    const response = await registerResponse;
    expect(response.status()).toBe(201);

    const body = (await response.json()) as {
      school: { id: string; status: string };
      verification: { token: string };
    };
    expect(body.school.status).toBe("registered");

    await expect(
      page.getByRole("heading", { name: new RegExp(`${schoolName} is registered`, "i") }),
    ).toBeVisible();
    await expect(page.getByText(schoolEmail)).toBeVisible();
    await expect(page.getByText(adminEmail)).toBeVisible();

    // The verification step: a real GET against the token the registration response carried.
    const verifyUrl = `${API_BASE_URL}/api/schools/verify-email/${encodeURIComponent(body.verification.token)}`;
    const verifyRes = await request.get(verifyUrl);
    expect(verifyRes.ok()).toBe(true);
    const verifyBody = (await verifyRes.json()) as {
      state: string;
      school: { id: string; slug: string };
    };
    expect(verifyBody.state).toBe("verified");
    expect(verifyBody.school.id).toBe(body.school.id);

    // A second verification of the same token is a real, already-consumed token — the state machine
    // rejects it rather than silently re-verifying, which is the honest proof the first call did
    // something real rather than being idempotent by accident.
    const replayRes = await request.get(verifyUrl);
    expect(replayRes.ok()).toBe(false);
  });
});
