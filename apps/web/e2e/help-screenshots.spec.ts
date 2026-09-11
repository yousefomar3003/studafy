import { mkdirSync } from "node:fs";

import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * Regenerates the onboarding-wizard screenshots the help articles reference. Run only through its
 * own config (`bun run e2e:help-screenshots`) so the default `e2e` run stays a pure test run:
 *
 *   Every backend call is stubbed via `page.route()` (same approach as `onboarding-setup.spec.ts`),
 *   and prior steps are marked completed in `localStorage` so each step renders in its
 *   happy-path state without having to click through the whole wizard. The captured PNGs land in
 *   `apps/web/public/help-media/screenshots/`, where the site serves them at
 *   `/help-media/screenshots/<name>.png`.
 *
 * If a step's markup changes, re-run this spec and commit the new images — do not hand-crop.
 */

const STORAGE_KEY = "studafy.onboarding-setup.v1";
const OUTPUT_DIR = "public/help-media/screenshots";

const STEPS = [
  { id: "school-profile", title: "School profile", file: "onboarding-school-profile.png" },
  { id: "academic-year", title: "Academic year", file: "onboarding-academic-year.png" },
  { id: "grading-scheme", title: "Grading scheme", file: "onboarding-grading-scheme.png" },
  { id: "timetable", title: "Timetable periods", file: "onboarding-timetable.png" },
  { id: "staff", title: "Staff invitations", file: "onboarding-staff.png" },
  { id: "students", title: "Student import", file: "onboarding-student-import.png" },
] as const;

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
  // The school-profile step fetches existing settings when nothing is cached. Served so the step
  // renders identically whether or not a seed provides cached values.
  await page.route("**/api/schools/current/settings", (route) =>
    fulfillJson(route, 200, {
      locale: "en",
      timezone: "Africa/Casablanca",
      invitation_expiry_days: 7,
      attendance_alert_threshold: 75,
      absence_alert_threshold: 25,
      parent_discipline_visibility: false,
      attendance_correction_window_hours: 48,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    }),
  );
}

/** Marks every step before `index` completed, leaves the target as the current step, and seeds the
 *  linked progress records later steps require (the academic year's id/term for grading scheme and
 *  timetable). Matches the shapes in `routes/onboarding-setup/progress.ts`. */
function seedProgressFor(index: number): string {
  const stepState = Object.fromEntries(
    STEPS.map((step, i) => [step.id, i < index ? "completed" : "upcoming"]),
  ) as Record<string, string>;

  const progress: Record<string, unknown> = {
    version: 1,
    currentStep: STEPS[index].id,
    stepState,
  };

  if (index >= 2) {
    progress.academicYear = {
      yearId: "year-1",
      termId: "term-1",
      code: "2025-2026",
      name: "AY 2025-2026",
      starts_on: "2025-09-01",
      ends_on: "2026-06-30",
    };
  }
  if (index >= 3) {
    progress.schoolProfile = {
      locale: "en",
      timezone: "Africa/Casablanca",
      invitation_expiry_days: 7,
      attendance_alert_threshold: 75,
      absence_alert_threshold: 25,
      parent_discipline_visibility: false,
      attendance_correction_window_hours: 48,
    };
  }
  if (index >= 4) {
    progress.gradingScheme = { schemeId: "scheme-1", name: "Standard Scale", schemeType: "letter" };
  }

  return JSON.stringify(progress);
}

test.describe("help center screenshots", () => {
  test.beforeEach(async ({ page }) => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    await stubAuthenticatedSession(page);
  });

  for (const [index, step] of STEPS.entries()) {
    test(`capture ${step.id}`, async ({ page }) => {
      await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
        STORAGE_KEY,
        seedProgressFor(index),
      ] as const);

      await page.goto("/onboarding/setup");
      await expect(page.getByRole("heading", { level: 2, name: step.title })).toBeVisible();

      await page.screenshot({
        path: `${OUTPUT_DIR}/${step.file}`,
        fullPage: true,
      });
    });
  }
});
