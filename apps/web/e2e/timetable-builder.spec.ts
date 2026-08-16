import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * End-to-end coverage for the timetable builder (ST-191): build a draft (create it, drag-assign a
 * class into a cell) and submit it for approval, against a stubbed backend — same approach as
 * `user-management.spec.ts`, no Postgres or `apps/api` process required.
 *
 * Placement uses the pick-then-place keyboard-equivalent path (click a class chip, then click a
 * cell) rather than a real HTML5 drag gesture: `dragTo()` against native `draggable` elements is
 * possible in Playwright but flaky across browsers, and both paths call the exact same
 * `assignSlot` in `TimetableGrid.tsx` — this is the accessible path, not a workaround for one that
 * only mice can use (see that component's own doc comment).
 */

const NOW = "2026-08-16T00:00:00.000Z";

const YEAR = {
  id: "year-1",
  school_id: "school-1",
  code: "2025-2026",
  name: "2025-2026",
  starts_on: "2025-09-01",
  ends_on: "2026-06-30",
  status: "active",
  created_at: NOW,
  updated_at: NOW,
};

const TERM = {
  id: "term-1",
  school_id: "school-1",
  academic_year_id: "year-1",
  code: "T1",
  name: "Term 1",
  sequence_number: 1,
  starts_on: "2025-09-01",
  ends_on: "2026-01-15",
  status: "active",
  created_at: NOW,
  updated_at: NOW,
};

const CLASS_A = {
  id: "class-a",
  school_id: "school-1",
  course_id: "course-1",
  academic_year_id: "year-1",
  term_id: "term-1",
  lead_teacher_id: "teacher-1",
  room_id: "room-1",
  code: "MATH-101",
  capacity: 30,
  status: "active",
  created_at: NOW,
  updated_at: NOW,
};

const CLASS_B = { ...CLASS_A, id: "class-b", room_id: "room-2", code: "SCI-201" };

const TEACHER_PROFILE = {
  id: "teacher-1",
  school_id: "school-1",
  user_id: "user-t1",
  employee_number: "EMP-001",
  employment_status: "active",
  hire_date: null,
  termination_date: null,
  created_at: NOW,
  updated_at: NOW,
};

const INSTRUCTOR_USER = {
  id: "user-t1",
  school_id: "school-1",
  email: "chen@example.edu",
  display_name: "Ms. Chen",
  status: "active",
  roles: ["INSTRUCTOR"],
  email_verified_at: null,
  last_login_at: null,
  created_at: NOW,
  updated_at: NOW,
};

const ROOM_1 = {
  id: "room-1",
  school_id: "school-1",
  code: "RM-101",
  name: "Room 101",
  room_type: "physical",
  capacity: 30,
  building: "Main",
  floor: "1",
  virtual_url: null,
  is_active: true,
  created_at: NOW,
  updated_at: NOW,
};

const ROOM_2 = { ...ROOM_1, id: "room-2", code: "RM-102", name: "Room 102" };

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

interface State {
  versions: Record<string, unknown>[];
  slots: Record<string, unknown>[];
}

async function stubTimetableBackend(page: Page): Promise<State> {
  const state: State = { versions: [], slots: [] };

  const pathIs = (url: string, pathname: string) => new URL(url).pathname === pathname;

  await page.route("**/api/academics/years*", async (route) => {
    if (!pathIs(route.request().url(), "/api/academics/years")) return route.fallback();
    return fulfillJson(route, 200, { academic_years: [YEAR], total: 1 });
  });

  await page.route("**/api/academics/years/*/terms*", (route) =>
    fulfillJson(route, 200, { terms: [TERM], total: 1 }),
  );

  await page.route("**/api/academics/classes*", async (route) => {
    if (!pathIs(route.request().url(), "/api/academics/classes")) return route.fallback();
    return fulfillJson(route, 200, { classes: [CLASS_A, CLASS_B], total: 2 });
  });

  await page.route("**/api/teachers*", async (route) => {
    if (!pathIs(route.request().url(), "/api/teachers")) return route.fallback();
    return fulfillJson(route, 200, { teachers: [TEACHER_PROFILE], next_cursor: null });
  });

  await page.route("**/api/users*", async (route) => {
    if (!pathIs(route.request().url(), "/api/users")) return route.fallback();
    return fulfillJson(route, 200, { users: [INSTRUCTOR_USER], next_cursor: null });
  });

  await page.route("**/api/academics/rooms*", async (route) => {
    if (!pathIs(route.request().url(), "/api/academics/rooms")) return route.fallback();
    return fulfillJson(route, 200, { rooms: [ROOM_1, ROOM_2], total: 2 });
  });

  await page.route("**/api/academics/timetable-versions*", async (route) => {
    if (!pathIs(route.request().url(), "/api/academics/timetable-versions"))
      return route.fallback();
    const request = route.request();
    if (request.method() === "GET") {
      return fulfillJson(route, 200, {
        timetable_versions: state.versions,
        total: state.versions.length,
      });
    }
    if (request.method() === "POST") {
      const body = request.postDataJSON() as {
        name: string;
        term_id: string;
        academic_year_id: string;
      };
      const version = {
        id: "version-1",
        school_id: "school-1",
        academic_year_id: body.academic_year_id,
        term_id: body.term_id,
        name: body.name,
        status: "draft",
        submitted_at: null,
        submitted_by_user_id: null,
        approved_at: null,
        approved_by_user_id: null,
        rejected_reason: null,
        created_at: NOW,
        updated_at: NOW,
      };
      state.versions = [version];
      return fulfillJson(route, 201, version);
    }
    return fulfillJson(route, 405, {});
  });

  await page.route("**/api/academics/timetable-versions/*/slots*", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      return fulfillJson(route, 200, { timetable_slots: state.slots, total: state.slots.length });
    }
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      const slot = {
        id: `slot-${state.slots.length + 1}`,
        school_id: "school-1",
        timetable_version_id: state.versions[0]?.id ?? "version-1",
        ...body,
        created_at: NOW,
        updated_at: NOW,
      };
      state.slots = [...state.slots, slot];
      return fulfillJson(route, 201, slot);
    }
    return fulfillJson(route, 405, {});
  });

  await page.route("**/api/academics/timetable-versions/*/submit", async (route) => {
    state.versions = state.versions.map((version) => ({ ...version, status: "pending" }));
    return fulfillJson(route, 200, state.versions[0]);
  });

  return state;
}

test.describe("timetable builder", () => {
  test("builds a draft and submits it for approval", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    await stubTimetableBackend(page);

    await page.goto("/portal/admin/timetable");

    await expect(page.getByRole("heading", { name: "Timetable builder" })).toBeVisible();
    await expect(
      page.getByText("Create a draft version to start building this term's schedule."),
    ).toBeVisible();

    // --- Draft versioning: create ---
    await page.getByRole("button", { name: "New draft" }).click();
    const createDialog = page.getByRole("dialog", { name: "New draft timetable" });
    await createDialog.getByLabel("Draft name").fill("Term 1 Weekly Schedule");
    await createDialog.getByRole("button", { name: "Create draft" }).click();

    await expect(page.locator('[data-status="draft"]')).toBeVisible();
    await expect(page.locator('[data-status="draft"]')).toHaveText("Draft");

    // --- Drag-assign: pick MATH-101, place it on Monday period 1 ---
    await page.getByRole("button", { name: "MATH-101" }).click();
    await page.getByRole("button", { name: "Place MATH-101 on Monday period 1" }).click();

    await expect(page.getByRole("button", { name: /MATH-101, Monday period 1/ })).toBeVisible();

    // --- Submit for approval ---
    await page.getByRole("button", { name: "Submit for approval" }).click();

    await expect(page.locator('[data-status="pending"]')).toBeVisible();
    await expect(page.locator('[data-status="pending"]')).toHaveText("Submitted");
    await expect(page.getByText("This version is submitted and read-only.")).toBeVisible();
    // Read-only: the class palette used to build the draft is gone (the placed slot itself, whose
    // accessible name contains "MATH-101" too, correctly remains — hence `exact` here).
    await expect(page.getByRole("button", { name: "MATH-101", exact: true })).toHaveCount(0);
  });
});
