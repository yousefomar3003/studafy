import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * End-to-end coverage for the report center (ST-206), against a stubbed backend — same
 * network-stubbing approach as `adjustments.spec.ts`, no Postgres or `apps/api` process required.
 * Covers what a component test cannot: a real browser click driving the run -> preview -> export ->
 * ready chain, and the empty-data state when a report run matches nothing.
 */

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

function buildArAgingReport(overrides: Record<string, unknown> = {}) {
  return {
    report_name: "Accounts Receivable Summary",
    columns: [
      { fieldname: "party_name", fieldtype: "Data", label: "Customer" },
      { fieldname: "range1", fieldtype: "Currency", label: "0-30" },
    ],
    rows: [{ party_name: "Haddad Family", range1: 120 }],
    report_summary: [{ label: "Total Outstanding", value: 120 }],
    presentation: {
      locale: "en",
      direction: "ltr",
      currency: "JOD",
      currency_precision: 3,
      currency_display: [{ range1: "120.000" }],
    },
    ...overrides,
  };
}

function buildQueuedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    report_type: "ar_aging",
    file_format: "csv",
    status: "queued",
    polling_url: "/api/finance/reports/export/job-1",
    download_url: null,
    download_url_expires_at: null,
    failure_message: null,
    created_at: "2026-08-21T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

async function stubReportsBackend(page: Page, arAgingReport: unknown) {
  const pathIs = (url: string, pathname: string) => new URL(url).pathname === pathname;
  let exportCalls = 0;

  await page.route("**/api/finance/reports/**", async (route) => {
    const url = route.request().url();
    if (pathIs(url, "/api/finance/reports/ar-aging")) {
      return fulfillJson(route, 200, arAgingReport);
    }
    if (pathIs(url, "/api/finance/reports/export") && route.request().method() === "POST") {
      exportCalls += 1;
      return fulfillJson(route, 202, buildQueuedJob());
    }
    // The export job is already `completed` by its first poll — this covers the queue -> ready
    // transition and its notification, not the 2s polling interval itself, same shortcut
    // `adjustments.spec.ts` takes elsewhere for its own async flows.
    if (pathIs(url, "/api/finance/reports/export/job-1")) {
      return fulfillJson(
        route,
        200,
        buildQueuedJob({
          status: "completed",
          download_url: "https://storage.example.com/reports/job-1.csv",
          download_url_expires_at: "2026-08-22T00:00:00.000Z",
        }),
      );
    }
    return route.fallback();
  });

  return { exportCallCount: () => exportCalls };
}

test.describe("finance report center", () => {
  test("runs the aging report, downloads it, and is notified once it's ready", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    const backend = await stubReportsBackend(page, buildArAgingReport());

    await page.goto("/portal/finance/reports");
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
    await expect(
      page.getByText("Set filters (optional) and run the report to see aging balances."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Run report" }).click();
    await expect(page.getByText("Haddad Family")).toBeVisible();
    await expect(page.getByText("Total Outstanding")).toBeVisible();

    const exportRequest = page.waitForRequest(
      (req) => req.url().includes("/api/finance/reports/export") && req.method() === "POST",
    );
    await page.getByRole("button", { name: "Download CSV" }).click();
    await exportRequest;

    await expect(page.getByText("Report ready")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Download Accounts receivable aging" }),
    ).toHaveAttribute("href", "https://storage.example.com/reports/job-1.csv");
    expect(backend.exportCallCount()).toBe(1);
  });

  test("running the aging report with no matching rows shows the empty-data state", async ({
    page,
  }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    await stubReportsBackend(page, buildArAgingReport({ rows: [], report_summary: [] }));

    await page.goto("/portal/finance/reports");
    await page.getByRole("button", { name: "Run report" }).click();

    await expect(page.getByText("No records match these filters.")).toBeVisible();
  });

  test("the family statement tab requires picking a family before it can run", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    await stubReportsBackend(page, buildArAgingReport());

    await page.goto("/portal/finance/reports");
    await page.getByRole("tab", { name: "Family statement" }).click();

    await expect(
      page.getByText("Pick a family and run the report to see its statement."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Run report" })).toBeDisabled();
  });
});
