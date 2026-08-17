import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * End-to-end coverage for announcement management (ST-194): composing a role-targeted, mandatory
 * announcement and seeing it land in the history list with its reach stats — against a stubbed
 * backend, the same approach as `audit-log-explorer.spec.ts`, no Postgres or `apps/api` process
 * required.
 *
 * This proves the UI *constructs the right request* for a targeted, mandatory, immediate-publish
 * announcement and renders the response it gets back. It does not, and cannot, prove that the
 * backend actually withholds the notice from other roles — a network-mocked browser test has no
 * real audience to under- or over-notify. That acceptance criterion ("targeted announcement reaches
 * only intended audience") is proved against a real database and two real seeded roles in
 * `apps/api/tests/announcements/announcements-http.test.ts`, which is the layer that can actually
 * prove it (see that file's own doc comment for the same reasoning `audit-log-explorer.spec.ts`
 * would give).
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

async function stubAuthenticatedSession(page: Page, roles: string[]) {
  await page.route("**/api/auth/refresh", (route) =>
    fulfillJson(route, 200, {
      access_token: fakeAccessToken(roles),
      expires_in: 3600,
      session_id: "session-1",
    }),
  );
}

const PUBLISHED_ANNOUNCEMENT = {
  id: "ann-1",
  school_id: "school-1",
  created_by: "admin-1",
  created_by_name: "Ada Lovelace",
  title: "Staff meeting moved to Friday",
  body: "Instructors only: staff meeting moved to Friday.",
  mandatory: true,
  audience_type: "role",
  audience_role: "INSTRUCTOR",
  audience_class_id: null,
  audience_class_code: null,
  status: "published",
  scheduled_at: NOW,
  published_at: NOW,
  recipient_count: 12,
  notified_count: 12,
  created_at: NOW,
  updated_at: NOW,
};

/** Stubs the class list, and the announcement list/create endpoints. The list starts empty; once
 * `POST /api/announcements` is called, subsequent `GET /api/announcements` calls return the one
 * created announcement — enough state to exercise "compose, then see it in history" without a real
 * queue or worker. */
async function stubAnnouncementsBackend(page: Page) {
  let created = false;
  const pathIs = (url: string, pathname: string) => new URL(url).pathname === pathname;

  await page.route("**/api/academics/classes*", async (route) => {
    if (!pathIs(route.request().url(), "/api/academics/classes")) return route.fallback();
    return fulfillJson(route, 200, {
      classes: [{ id: "class-1", code: "CLASS-MATH-101" }],
      total: 1,
    });
  });

  await page.route("**/api/announcements*", async (route) => {
    if (!pathIs(route.request().url(), "/api/announcements")) return route.fallback();

    if (route.request().method() === "POST") {
      created = true;
      return fulfillJson(route, 201, PUBLISHED_ANNOUNCEMENT);
    }

    return fulfillJson(route, 200, {
      items: created ? [PUBLISHED_ANNOUNCEMENT] : [],
      next_cursor: null,
    });
  });
}

test.describe("announcement management", () => {
  test("composes a role-targeted mandatory announcement and sees it in history with reach stats", async ({
    page,
  }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
    await stubAnnouncementsBackend(page);

    await page.goto("/portal/admin/announcements");

    await expect(page.getByRole("heading", { name: "Announcements" })).toBeVisible();

    await page.getByLabel("Title", { exact: false }).fill("Staff meeting moved to Friday");
    await page
      .getByLabel("Message", { exact: false })
      .fill("Instructors only: staff meeting moved to Friday.");
    await page.getByRole("checkbox", { name: /Mandatory/ }).check();
    await page.getByRole("radio", { name: "Everyone with a role" }).check();

    await page.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "Instructor" }).click();

    const postRequest = page.waitForRequest(
      (req) => req.url().includes("/api/announcements") && req.method() === "POST",
    );
    await page.getByRole("button", { name: "Publish now" }).click();
    const request = await postRequest;
    expect(request.postDataJSON()).toMatchObject({
      title: "Staff meeting moved to Friday",
      mandatory: true,
      audience_type: "role",
      audience_role: "INSTRUCTOR",
    });

    await expect(page.getByText("Announcement published")).toBeVisible();

    const grid = page.getByRole("region", { name: "Announcement history" });
    await expect(grid.getByText("Staff meeting moved to Friday")).toBeVisible();
    await expect(grid.getByText("Mandatory")).toBeVisible();
    await expect(grid.getByText("12 / 12")).toBeVisible();
  });
});
