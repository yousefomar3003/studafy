import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * Device sessions screen (ST-281): the two-browser acceptance criterion — a device revoked from the
 * account sessions screen fails on that device's next refresh, i.e. the session dies and the user
 * is sent back to the login screen.
 *
 * Same fully-stubbed approach as `user-management.spec.ts`: everything under `/api/` is intercepted
 * with `page.route`, so no Postgres or `apps/api` process is required. Browser A and Browser B are
 * two independent `BrowserContext`s against the same app, each with its own refresh cookie story.
 */

function fakeAccessToken(sessionId: string): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256" })}.${segment({ sub: "user-1", roles: ["ORG_ADMIN"], sessionId })}.signature`;
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/**
 * Whatever else the app shell fetches on mount. Registered first so the specific handlers below
 * shadow it (Playwright matches routes last-registered-first, the same order `stubPortalShellDefaults`
 * relies on in user-management.spec.ts).
 */
async function stubShellDefaults(page: Page) {
  await page.route("**/api/**", (route) => fulfillJson(route, 200, {}));
}

const SESSION_A = {
  id: "session-a",
  device_id: "device-a",
  device_name: "Chrome — Work laptop",
  channel: "web",
  user_agent: "ua-a",
  ip_address: "203.0.113.10",
  issued_at: "2026-08-14T08:00:00.000Z",
  expires_at: "2026-09-13T08:00:00.000Z",
};

const SESSION_B = {
  id: "session-b",
  device_id: "device-b",
  device_name: "Firefox — Home laptop",
  channel: "web",
  user_agent: "ua-b",
  ip_address: "203.0.113.20",
  issued_at: "2026-08-14T08:30:00.000Z",
  expires_at: "2026-09-13T08:30:00.000Z",
};

const DEVICE_A = {
  id: "device-a",
  platform: "Windows",
  last_seen: SESSION_A.issued_at,
  created_at: "2026-08-01T09:00:00.000Z",
  active_session_count: 1,
};

const DEVICE_B = {
  id: "device-b",
  platform: "Linux",
  last_seen: SESSION_B.issued_at,
  created_at: "2026-08-01T09:00:00.000Z",
  active_session_count: 1,
};

/**
 * Stubs the account sessions screen for one browser context. `currentSessionId` decides which of
 * the two sessions the refresh stub presents as "this" session. `isRevoked` lets the refresh route
 * start answering 401 once the device carrying that session has been revoked — the trigger for the
 * sign-out that a real revoked refresh cookie would produce.
 */
async function stubSessionsBackend(
  page: Page,
  currentSessionId: string,
  isRevoked: () => boolean = () => false,
) {
  await page.route("**/api/auth/refresh", async (route) => {
    if (isRevoked()) {
      return fulfillJson(route, 401, { title: "Unauthorized", detail: "Session revoked" });
    }
    return fulfillJson(route, 200, {
      access_token: fakeAccessToken(currentSessionId),
      expires_in: 3600,
      session_id: currentSessionId,
    });
  });

  await page.route("**/api/auth/sessions", (route) =>
    fulfillJson(route, 200, { sessions: [SESSION_A, SESSION_B] }),
  );

  await page.route("**/api/auth/devices", (route) =>
    fulfillJson(route, 200, { devices: [DEVICE_A, DEVICE_B] }),
  );

  await page.route("**/api/auth/devices/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    return fulfillJson(route, 200, { revoked: 1, denylisted: 1 });
  });
}

test.describe("device sessions", () => {
  test("revoking a device makes it fail on its next refresh (two browsers)", async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await stubShellDefaults(pageA);
    await stubShellDefaults(pageB);
    await stubSessionsBackend(pageA, "session-a");
    let deviceBRevoked = false;
    await stubSessionsBackend(pageB, "session-b", () => deviceBRevoked);

    // Browser A sees both sessions, marks its own device, and revokes browser B's device.
    await pageA.goto("/account/sessions");
    await expect(pageA.getByRole("heading", { name: "Devices & sessions" })).toBeVisible();
    await expect(pageA.getByText("This device")).toBeVisible();
    await expect(pageA.getByText("Current session")).toBeVisible();

    const deviceBRow = pageA.getByRole("listitem").filter({ hasText: "Linux" });
    await deviceBRow.getByRole("button", { name: "Remove device" }).click();

    const removeDialog = pageA.getByRole("dialog", { name: "Remove this device?" });
    await expect(removeDialog).toBeVisible();

    const deleteDeviceB = pageA.waitForRequest(
      (request) =>
        request.method() === "DELETE" && request.url().includes("/api/auth/devices/device-b"),
    );
    await removeDialog.getByRole("button", { name: "Remove" }).click();
    await deleteDeviceB;

    // Browser B is mid-session: establish a valid, authenticated context before the revocation.
    await pageB.goto("/account/sessions");
    await expect(pageB.getByRole("heading", { name: "Devices & sessions" })).toBeVisible();
    await expect(pageB.getByText("This device")).toBeVisible();

    // Browser B's refresh cookie is now dead; its next refresh must fail.
    deviceBRevoked = true;

    // Browser B is mid-session; a reload restarts the session and re-checks the refresh cookie,
    // which is what "next refresh" means here.
    await pageB.reload();

    // The revoked session is treated as expired and the user lands on the login screen.
    await expect(pageB).toHaveURL(/\/auth\/login/, { timeout: 15_000 });

    await contextA.close();
    await contextB.close();
  });
});
