import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * End-to-end coverage for the audit log explorer (ST-193): the diff viewer for a changed entry and
 * the CSV export flow end to end (queue → poll → ready, with a download link), against a stubbed
 * backend — the same approach as `user-management.spec.ts`, no Postgres or `apps/api` process
 * required.
 */

const NOW = "2026-08-17T09:00:00.000Z";

function fakeAccessToken(roles: string[]): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256" })}.${segment({ sub: "admin-1", roles })}.signature`;
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
      access_token: fakeAccessToken(["ORG_ADMIN"]),
      expires_in: 3600,
      session_id: "session-1",
    }),
  );
}

const AUDIT_ENTRY = {
  id: "audit-1",
  created_at: NOW,
  action: "update",
  actor_id: "user-1",
  actor_name: "Ada Lovelace",
  actor_email: "ada@example.edu",
  target_table: "students",
  target_id: "11111111-1111-1111-1111-111111111111",
  client_ip: "10.0.0.1",
  user_agent: "test-agent",
  request_id: "req-1",
  old_values: { status: "active" },
  new_values: { status: "suspended" },
};

/** Stubs the list, export-creation, and export-polling endpoints. The export job starts `queued`,
 * reports `processing` on its first poll, then `completed` with a download link — enough ticks to
 * exercise the page's polling loop without a real queue/worker. */
async function stubAuditBackend(page: Page) {
  let pollCount = 0;
  const pathIs = (url: string, pathname: string) => new URL(url).pathname === pathname;

  // `*` after `logs` matters: the list request carries `?limit=...&...` query params, and a bare
  // `"**/api/audit/logs"` glob (no trailing wildcard) does not match a URL with a query string —
  // see `timetable-builder.spec.ts`'s `pathIs` helper for the same fix on the same failure mode.
  await page.route("**/api/audit/logs*", async (route) => {
    if (!pathIs(route.request().url(), "/api/audit/logs") || route.request().method() !== "GET") {
      return route.fallback();
    }
    return fulfillJson(route, 200, {
      generated_at: NOW,
      filter: { from: NOW, to: NOW },
      limit: 100,
      items: [AUDIT_ENTRY],
      next_cursor: null,
      has_more: false,
    });
  });

  await page.route("**/api/audit/logs/export", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return fulfillJson(route, 202, {
      id: "export-1",
      file_format: "csv",
      status: "queued",
      created_at: NOW,
      completed_at: null,
      download_url: null,
      download_url_expires_at: null,
      failure_message: null,
    });
  });

  await page.route("**/api/audit/logs/export/export-1", async (route) => {
    pollCount += 1;
    if (pollCount === 1) {
      return fulfillJson(route, 200, {
        id: "export-1",
        file_format: "csv",
        status: "processing",
        created_at: NOW,
        completed_at: null,
        download_url: null,
        download_url_expires_at: null,
        failure_message: null,
      });
    }
    return fulfillJson(route, 200, {
      id: "export-1",
      file_format: "csv",
      status: "completed",
      created_at: NOW,
      completed_at: NOW,
      download_url: "https://storage.example.test/exports/export-1.csv?signature=abc",
      download_url_expires_at: "2026-08-17T09:15:00.000Z",
      failure_message: null,
    });
  });
}

test.describe("audit log explorer", () => {
  test("views a diff and exports a CSV end to end", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    await stubAuditBackend(page);

    await page.goto("/portal/admin/audit");

    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    const grid = page.getByRole("region", { name: "Audit log entries" });
    await expect(grid.getByText("Ada Lovelace")).toBeVisible();

    // --- Diff viewer ---
    await grid.getByRole("button", { name: "View diff" }).click();
    const dialog = page.getByRole("dialog", { name: "Audit entry diff" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("status")).toBeVisible();
    await expect(dialog.getByText("active")).toBeVisible();
    await expect(dialog.getByText("suspended")).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    // --- CSV export: trigger, queued toast, poll to completion, download link ---
    await page.getByRole("button", { name: "Export CSV" }).click();
    await expect(page.getByText("Audit export queued")).toBeVisible();

    await expect(page.getByText("Audit export ready")).toBeVisible();
    const downloadLink = page.getByRole("link", { name: "Download CSV" });
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveAttribute(
      "href",
      "https://storage.example.test/exports/export-1.csv?signature=abc",
    );
  });
});
