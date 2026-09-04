import { expect } from "@playwright/test";

import { API_BASE_URL } from "./ports";

import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Drives a real browser through the mock OAuth login (see mock-route.ts and LoginPage.tsx's
 * "Continue with Mock" button, shown only when `VITE_ENABLE_MOCK_AUTH=true` — see the web
 * `webServer` env in playwright.critical.config.ts). This is the actual production login code path
 * with a real third provider swapped in, not a stub: a full-page redirect to `/api/auth/oauth/mock/
 * start`, on to the mock IdP's `/authorize`, back to `/api/auth/oauth/mock/callback`, which sets the
 * real HttpOnly refresh cookie and redirects to `/auth/callback`, which restores the session and
 * lands on `/portal`.
 */
export async function loginInBrowser(page: Page, email: string): Promise<void> {
  await page.goto(`/auth/login?login_hint=${encodeURIComponent(email)}`);
  await page.getByRole("button", { name: "Continue with Mock" }).click();
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
}

/**
 * Obtains a bearer access token for a persona without a browser, for the steps of a journey that
 * have no web UI to drive (see the ST-246 journey catalog — several critical steps are
 * teacher/student/parent-only and exist only in the Flutter mobile app).
 *
 * Runs the *same* mock OAuth redirect chain `loginInBrowser` does, but through Playwright's
 * `APIRequestContext`, which follows redirects and persists cookies automatically — so one request
 * to `/oauth/mock/start` walks start → mock IdP → callback and captures the refresh cookie the
 * callback sets, exactly as a browser would. `POST /api/auth/refresh` (cookie-authenticated) then
 * hands back the access token that cookie is good for.
 */
export async function apiLoginAs(request: APIRequestContext, email: string): Promise<string> {
  const started = await request.get(`${API_BASE_URL}/api/auth/oauth/mock/start`, {
    params: { login_hint: email },
  });
  if (!started.ok()) {
    throw new Error(
      `mock OAuth login for ${email} failed: ${started.status()} ${await started.text()}`,
    );
  }

  const refreshed = await request.post(`${API_BASE_URL}/api/auth/refresh`);
  if (!refreshed.ok()) {
    throw new Error(
      `POST /api/auth/refresh for ${email} failed: ${refreshed.status()} ${await refreshed.text()}`,
    );
  }

  const body = (await refreshed.json()) as { access_token: string };
  return body.access_token;
}

/**
 * Activates a brand-new invitee via the mock OAuth provider without a browser, then returns a
 * bearer access token for the account it just created — the API-only counterpart to
 * {@link apiLoginAs} for a user who has never signed in before (see the invoice→payment journey,
 * which needs a freshly-registered, freshly-provisioned school no seeded persona belongs to).
 * Same redirect-following + cookie-then-refresh trick as apiLoginAs, against the activation start
 * endpoint instead of the login one.
 */
export async function apiActivateAndLoginAs(
  request: APIRequestContext,
  invitationToken: string,
  email: string,
): Promise<string> {
  const started = await request.get(
    `${API_BASE_URL}/api/auth/invitations/${invitationToken}/oauth/mock/start`,
    { params: { login_hint: email } },
  );
  if (!started.ok()) {
    throw new Error(
      `mock OAuth activation for ${email} failed: ${started.status()} ${await started.text()}`,
    );
  }

  const refreshed = await request.post(`${API_BASE_URL}/api/auth/refresh`);
  if (!refreshed.ok()) {
    throw new Error(
      `POST /api/auth/refresh after activating ${email} failed: ${refreshed.status()} ${await refreshed.text()}`,
    );
  }

  const body = (await refreshed.json()) as { access_token: string };
  return body.access_token;
}

/** `Authorization` header for a bearer token from {@link apiLoginAs}. */
export function bearer(accessToken: string): { Authorization: string } {
  return { Authorization: `Bearer ${accessToken}` };
}
