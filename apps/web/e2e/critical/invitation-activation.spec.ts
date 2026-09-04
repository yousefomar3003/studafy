import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { apiLoginAs, bearer } from "./support/auth";
import { PERSONAS } from "./support/personas";
import { API_BASE_URL } from "./support/ports";

/**
 * Journey 2/7: invitation activation.
 *
 * A real `SUPER_ADMIN`/`ORG_ADMIN` bearer token creates a real invitation (`POST /api/invitations`),
 * whose raw one-time activation token is returned directly in that response — the same way an E2E
 * run with no email inbox to check gets it (see `activation-oauth-routes.ts`'s doc comment: the raw
 * token is otherwise only ever delivered by email). Everything from there is browser-driven and
 * genuinely live: `/invite/:token` really calls `GET /api/auth/invitations/{token}/verify`, the
 * "Continue with Mock" link really round-trips through the mock OAuth provider
 * (`activation-oauth-routes.ts`'s mock branch), and the server really runs `activateAccount` —
 * creating the user, linking the oauth identity, and issuing the first session.
 *
 * Invited as ORG_ADMIN rather than a teacher/student/parent role: the web app has exactly one
 * authenticated home today (`role-home.ts`) and only admin/principal/finance screens exist behind
 * it (see the ST-246 journey catalog) — an admin activating is both a real, common journey and the
 * one role guaranteed to land somewhere this suite can meaningfully assert on.
 */
test.describe("invitation activation", () => {
  test("a new admin activates their account via the mock OAuth provider", async ({
    page,
    request,
  }) => {
    const adminToken = await apiLoginAs(request, PERSONAS.orgAdmin);
    const inviteeEmail = `new-admin+${randomUUID().slice(0, 8)}@e2e-academy.test`;

    const createRes = await request.post(`${API_BASE_URL}/api/invitations`, {
      headers: bearer(adminToken),
      data: { email: inviteeEmail, role: "ORG_ADMIN" },
    });
    expect(createRes.ok()).toBe(true);
    const { token } = (await createRes.json()) as { token: string };
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    await page.goto(`/invite/${token}?login_hint=${encodeURIComponent(inviteeEmail)}`);
    await expect(page.getByRole("heading", { name: /you.?re invited/i })).toBeVisible();

    await page.getByRole("link", { name: "Continue with Mock" }).click();

    // activation-oauth-routes.ts's callback lands on /invite/:token/complete, which restores the
    // session from the refresh cookie the callback just set and routes home by role — /portal for
    // every role today (role-home.ts). A working admin portal is the proof activation succeeded:
    // no session, no permission, no render.
    await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });

    // The invitation is now consumed — re-verifying it must report CONSUMED, the honest proof the
    // activation transaction actually committed rather than the browser merely reaching /portal by
    // some unrelated path.
    const verifyRes = await request.get(`${API_BASE_URL}/api/auth/invitations/${token}/verify`);
    expect(verifyRes.status()).toBe(409);
    const verifyBody = (await verifyRes.json()) as { code: string };
    expect(verifyBody.code).toBe("CONSUMED");
  });
});
