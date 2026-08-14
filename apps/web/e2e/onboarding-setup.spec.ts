import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * End-to-end coverage for the post-activation setup wizard. Every backend call is stubbed via
 * `page.route()`, the same approach as `registration.spec.ts` — no Postgres or `apps/api` process
 * required, just the Vite dev server, but a real browser driving real DOM and navigation.
 *
 * Unlike the public registration flow, this wizard sits behind `RequireAuth` + `RequirePermission`.
 * `POST /api/auth/refresh` is stubbed to hand back a fake access token carrying the `ORG_ADMIN`
 * role, so the session store's cookie-based restore (`lib/auth/session-store.ts`) resolves to
 * "authenticated" without a real refresh cookie, and `ORG_ADMIN` carries
 * `organization:manageSettings` (see `packages/constants/src/permissions.ts`), the permission the
 * wizard route requires.
 */

function fakeAccessToken(roles: string[]): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256" })}.${segment({ sub: "admin-1", roles })}.signature`;
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
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

const SETTINGS = {
  locale: "en",
  timezone: "Africa/Casablanca",
  invitation_expiry_days: 7,
  attendance_alert_threshold: 75,
  absence_alert_threshold: 25,
  parent_discipline_visibility: false,
  attendance_correction_window_hours: 48,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

async function stubWizardBackend(page: Page) {
  await page.route("**/api/schools/current/settings", (route) => {
    if (route.request().method() === "GET") return fulfillJson(route, 200, SETTINGS);
    return fulfillJson(route, 200, SETTINGS);
  });

  await page.route("**/api/academics/years", (route) =>
    fulfillJson(route, 201, {
      id: "year-1",
      school_id: "school-1",
      code: "2025-2026",
      name: "AY 2025-2026",
      starts_on: "2025-09-01",
      ends_on: "2026-06-30",
      status: "active",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    }),
  );

  await page.route("**/api/academics/years/*/terms", (route) =>
    fulfillJson(route, 201, {
      id: "term-1",
      school_id: "school-1",
      academic_year_id: "year-1",
      code: "FY",
      name: "Full Year",
      sequence_number: 1,
      starts_on: "2025-09-01",
      ends_on: "2026-06-30",
      status: "active",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    }),
  );

  await page.route("**/api/grades/config/schemes", (route) =>
    fulfillJson(route, 201, {
      id: "scheme-1",
      term_id: "term-1",
      version: 1,
      name: "Standard Scale",
      scheme_type: "letter",
      grade_boundaries: [],
      is_inherited: false,
      created_at: "2026-08-01T00:00:00.000Z",
    }),
  );

  await page.route("**/api/academics/timetable-versions", (route) =>
    fulfillJson(route, 201, {
      id: "version-1",
      term_id: "term-1",
      academic_year_id: "year-1",
      name: "Draft Timetable",
      status: "draft",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    }),
  );

  await page.route("**/api/invitations/bulk", (route) =>
    fulfillJson(route, 201, {
      id: "batch-1",
      role: "INSTRUCTOR",
      expiry_days: 7,
      target_mode: "explicit",
      total_count: 1,
      sent_count: 1,
    }),
  );

  const uploadResponse = {
    id: "import-1",
    school_id: "school-1",
    uploaded_by: "admin-1",
    status: "uploaded",
    file_name: "students.csv",
    row_count: 2,
    valid_rows: 1,
    error_rows: 1,
    errors: [{ line: 2, field: "email", message: "Invalid email address." }],
    summary: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    confirmed_at: null,
    completed_at: null,
  };

  await page.route("**/api/imports/students/upload", (route) =>
    fulfillJson(route, 201, uploadResponse),
  );
  await page.route("**/api/imports/students/*/confirm", (route) =>
    fulfillJson(route, 200, {
      ...uploadResponse,
      status: "confirmed",
      confirmed_at: "2026-08-01T00:00:00.000Z",
    }),
  );
}

test.describe("post-activation setup wizard", () => {
  test("completes every step, downloads the CSV dry-run error report, and lands on the dashboard", async ({
    page,
  }) => {
    await stubAuthenticatedSession(page);
    await stubWizardBackend(page);

    await page.goto("/onboarding/setup");

    await expect(page.getByRole("heading", { name: /school profile/i })).toBeVisible();
    await page.getByRole("button", { name: /save and continue/i }).click();

    await expect(page.getByRole("heading", { name: /^academic year$/i })).toBeVisible();
    await page.getByLabel(/year code/i).fill("2025-2026");
    await page.getByLabel(/year name/i).fill("AY 2025-2026");
    await page.getByLabel(/start date/i).fill("2025-09-01");
    await page.getByLabel(/end date/i).fill("2026-06-30");
    await page.getByRole("button", { name: /save and continue/i }).click();

    await expect(page.getByRole("heading", { name: /grading scheme/i })).toBeVisible();
    await page.getByRole("button", { name: /save and continue/i }).click();

    await expect(page.getByRole("heading", { name: /timetable periods/i })).toBeVisible();
    await page.getByRole("button", { name: /save and continue/i }).click();

    await expect(page.getByRole("heading", { name: /staff invitations/i })).toBeVisible();
    await page.getByLabel(/emails/i).fill("teacher@example.com");
    await page.getByRole("button", { name: /send invitations/i }).click();

    await expect(page.getByRole("heading", { name: /student import/i })).toBeVisible();
    await page.getByLabel(/student csv file/i).setInputFiles({
      name: "students.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("admission_number,email\n1,not-an-email"),
    });

    await expect(page.getByText("Invalid email address.")).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /download error report/i }).click();
    expect((await download).suggestedFilename()).toMatch(/^import-errors-.*\.csv$/);

    await page.getByRole("button", { name: /confirm import/i }).click();
    await expect(page.getByText(/import confirmed/i)).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: /setup complete/i })).toBeVisible();
    await page.getByRole("button", { name: /go to dashboard/i }).click();

    await expect(page).toHaveURL(/\/portal$/);
  });

  test("resumes on the same step after a reload instead of restarting", async ({ page }) => {
    await stubAuthenticatedSession(page);
    await stubWizardBackend(page);

    await page.goto("/onboarding/setup");
    await page.getByRole("button", { name: /save and continue/i }).click();
    await expect(page.getByRole("heading", { name: /^academic year$/i })).toBeVisible();

    await page.reload();

    await expect(page.getByRole("heading", { name: /^academic year$/i })).toBeVisible();
  });
});
