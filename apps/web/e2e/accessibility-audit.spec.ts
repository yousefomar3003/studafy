import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";
import type { Result } from "axe-core";

/**
 * CI's axe budget for the web portal (ST-211): zero critical/serious violations on the routes
 * covered here.
 *
 * This is the one place in the suite that can actually check color contrast — `lib/test/axe.ts`
 * (the component-test helper every `a11y.test.tsx` uses) disables `color-contrast` because
 * happy-dom has no layout or cascade to sample painted pixels from. Real Chromium does, so this
 * file runs full default axe rules — no rule list, no exclusions — against a stubbed backend, the
 * same no-Postgres approach every other spec in this directory uses.
 *
 * Violations are split by impact: `critical`/`serious` fail the run (the acceptance budget);
 * `moderate`/`minor` are logged to the report but never fail it, so a low-severity finding doesn't
 * block a merge while it's still visible. If this list grows, add the new route's stub next to the
 * others below rather than opening a second file — one shared `runAudit` keeps every route's pass/
 * fail rule identical.
 */

const NOW = "2026-08-23T09:00:00.000Z";
const GATING_IMPACTS = new Set(["critical", "serious"]);

// Every dialog and popover in `@studafy/ui` fades/slides in over `--duration-base` (200ms) — real
// motion, correctly skipped under `prefers-reduced-motion: reduce` (see `modal.css`). Auditing with
// it on is what a motion-sensitive visitor's browser actually renders, and it also makes the audit
// deterministic: without it, axe can sample a mid-transition frame (the modal blended with the
// overlay behind it) and report a false `color-contrast` violation for a state no user ever reads.
test.use({ reducedMotion: "reduce" });

function fakeAccessToken(roles: string[]): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256" })}.${segment({ sub: "user-1", roles })}.signature`;
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

function describeViolation(violation: Result): string {
  const targets = violation.nodes.map((node) => `      ${node.target.join(" ")}`).join("\n");
  return `  [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n${targets}`;
}

/**
 * Runs the full default axe ruleset against the current page and enforces the critical/serious
 * budget. Anything below that impact is reported (via `test.info().attach`) but does not fail.
 *
 * One `analyze()` call per `page` in the whole suite, no exceptions: axe-core's own color-contrast
 * check caches per-element background lookups in a way that does not invalidate between repeat
 * `analyze()` calls on the same page. Auditing state A, then interacting and auditing state B on
 * that same `page` reliably resurfaces state A's stale cache and misreports state B — reproduced by
 * hand against the approval-diff modal (verified false: two fresh single-audit runs against that
 * exact modal state report zero violations). Each state below gets its own test and its own `page`
 * fixture so every `analyze()` call is the first and only one that page ever sees.
 */
async function runAudit(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();

  const gating = results.violations.filter(
    (violation) => violation.impact && GATING_IMPACTS.has(violation.impact),
  );
  const advisory = results.violations.filter((violation) => !gating.includes(violation));

  if (advisory.length > 0) {
    await test.info().attach("axe-advisory-violations (moderate/minor, non-gating)", {
      body: advisory.map(describeViolation).join("\n\n"),
      contentType: "text/plain",
    });
  }

  expect(
    gating.length,
    `Expected no critical/serious accessibility violations, found ${gating.length}:\n` +
      gating.map(describeViolation).join("\n\n"),
  ).toBe(0);
}

// ---------------------------------------------------------------------------
// Approval queue — list, diff modal, reject-reason modal.
// ---------------------------------------------------------------------------

test.describe("approval queue", () => {
  const ITEM = {
    id: "item-a",
    item_type: "grade_submission",
    status: "submitted",
    summary: "Grade 9 Math — Q3 midterm",
    requested_by_user_id: "user-1",
    requested_by_display_name: "Jamie Chen",
    requested_at: NOW,
    decided_at: null,
    diff: {
      gradebook_id: "gb-1",
      gradebook_class_code: "G9-MATH",
      student_id: "student-1",
      student_name: "Alex Kim",
      grade_count: 1,
      grades: [{ label: "Midterm", score: 85, max_score: 100, weight: 1 }],
    },
  };

  async function stubApprovals(page: Page) {
    await page.route("**/api/approvals/queue**", (route) =>
      fulfillJson(route, 200, { items: [ITEM], total: 1 }),
    );
  }

  test("list has no critical/serious violations", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
    await stubApprovals(page);

    await page.goto("/portal/approvals");
    await expect(page.getByText("Grade 9 Math — Q3 midterm")).toBeVisible();
    await runAudit(page);
  });

  test("diff modal has no critical/serious violations", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
    await stubApprovals(page);

    await page.goto("/portal/approvals");
    await expect(page.getByText("Grade 9 Math — Q3 midterm")).toBeVisible();
    await page.getByRole("button", { name: "View diff" }).click();
    await expect(page.getByRole("dialog", { name: "What changed" })).toBeVisible();
    await runAudit(page);
  });
});

// ---------------------------------------------------------------------------
// Notifications — inbox and preferences.
// ---------------------------------------------------------------------------

test.describe("notifications", () => {
  async function stubNotifications(page: Page) {
    await page.route("**/api/notifications/unread-count", (route) =>
      fulfillJson(route, 200, { unread_count: 1 }),
    );
    await page.route("**/api/notifications**", async (route) => {
      if (new URL(route.request().url()).pathname !== "/api/notifications") {
        return route.fallback();
      }
      return fulfillJson(route, 200, {
        next_cursor: null,
        notifications: [
          {
            id: "n-1",
            school_id: "school-1",
            user_id: "user-1",
            notification_type: "ASSIGNMENT_DUE_SOON",
            title: "Algebra homework due",
            body: "Homework 4 is due Friday.",
            metadata: {},
            read_at: null,
            created_at: NOW,
            updated_at: NOW,
          },
        ],
      });
    });
    await page.route("**/api/notification-preferences", (route) =>
      fulfillJson(route, 200, {
        attendance_alert_threshold: null,
        preferences: ["in_app", "push", "email"].map((channel) => ({
          notification_type: "ASSIGNMENT_DUE_SOON",
          channel,
          enabled: true,
          digest: false,
          mandatory: false,
          digest_eligible: channel === "email",
        })),
      }),
    );
  }

  test("inbox has no critical/serious violations", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["STUDENT"]);
    await stubNotifications(page);

    await page.goto("/portal/notifications");
    await expect(page.getByText("Algebra homework due")).toBeVisible();
    await runAudit(page);
  });

  test("preferences has no critical/serious violations", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["STUDENT"]);
    await stubNotifications(page);

    await page.goto("/portal/notifications/preferences");
    await expect(page.getByRole("heading", { name: "Notification settings" })).toBeVisible();
    await runAudit(page);
  });
});

// ---------------------------------------------------------------------------
// Admin: invitations list and the new-invitation modal.
// ---------------------------------------------------------------------------

test.describe("admin invitations", () => {
  async function stubInvitations(page: Page) {
    await page.route("**/api/invitations**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return fulfillJson(route, 200, {
        invitations: [
          {
            id: "invitation-1",
            email: "jamie@example.edu",
            role: "INSTRUCTOR",
            status: "pending",
            expires_at: "2026-08-30T00:00:00.000Z",
            revoked_at: null,
            consumed_at: null,
            invited_by_user_id: "user-1",
            created_at: NOW,
          },
        ],
        next_cursor: null,
        bulk_invites: [],
      });
    });
  }

  test("list has no critical/serious violations", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
    await stubInvitations(page);

    await page.goto("/portal/admin/invitations");
    await expect(page.getByText("jamie@example.edu")).toBeVisible();
    await runAudit(page);
  });

  test("new-invitation modal has no critical/serious violations", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
    await stubInvitations(page);

    await page.goto("/portal/admin/invitations");
    await expect(page.getByText("jamie@example.edu")).toBeVisible();
    await page.getByRole("button", { name: "New invitation" }).click();
    await expect(page.getByRole("dialog", { name: "New invitation" })).toBeVisible();
    await runAudit(page);
  });
});

// ---------------------------------------------------------------------------
// Finance: payment recording form.
// ---------------------------------------------------------------------------

test.describe("finance payments", () => {
  test("record-payment form has no critical/serious violations", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["FINANCE"]);
    await page.route("**/api/finance/invoices**", (route) =>
      fulfillJson(route, 200, {
        invoices: [
          {
            id: "invoice-1",
            school_id: "school-1",
            student_id: "student-1",
            student_name: "Layla Haddad",
            admission_number: "ADM-001",
            erpnext_docname: "ACC-SINV-2026-00001",
            erpnext_status: "submitted",
            total_amount: "1000.000",
            total_amount_minor: 1000000,
            outstanding_amount: "1000.000",
            outstanding_amount_minor: 1000000,
            currency: "JOD",
            currency_minor_unit: 3,
            issued_date: "2026-08-01",
            due_date: "2026-09-01",
            last_synced_at: NOW,
          },
        ],
        next_cursor: null,
      }),
    );

    await page.goto("/portal/finance/payments/new");
    await expect(page.getByRole("heading", { name: "Record a payment" })).toBeVisible();
    await runAudit(page);
  });
});

// ---------------------------------------------------------------------------
// Discipline: teacher-reported inbox.
// ---------------------------------------------------------------------------

test.describe("discipline", () => {
  test("incident inbox has no critical/serious violations", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
    await page.route("**/api/schools/current/settings", (route) =>
      fulfillJson(route, 200, { parent_discipline_visibility: true }),
    );
    await page.route("**/api/discipline/incidents**", (route) =>
      fulfillJson(route, 200, {
        incidents: [
          {
            id: "incident-1",
            school_id: "school-1",
            student_id: "student-1",
            class_id: null,
            reporter_user_id: "teacher-1",
            incident_type: "behavioral",
            severity: "major",
            status: "reported",
            title: "Cafeteria altercation",
            description: "Shoving match during lunch.",
            incident_at: NOW,
            resolved_at: null,
            created_at: NOW,
            updated_at: NOW,
          },
        ],
        total: 1,
      }),
    );

    await page.goto("/portal/principal/discipline");
    await expect(page.getByRole("heading", { name: "Discipline incidents" })).toBeVisible();
    await runAudit(page);
  });
});

// ---------------------------------------------------------------------------
// Public marketing site — no auth, real color-contrast matters most here (first-impression pages).
// ---------------------------------------------------------------------------

test.describe("marketing site", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/**", (route) => fulfillJson(route, 200, []));
  });

  for (const path of ["/", "/features", "/pricing", "/about"]) {
    test(`${path} has no critical/serious violations`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await runAudit(page);
    });
  }
});

test.describe("sign in", () => {
  test("login prompt has no critical/serious violations", async ({ page }) => {
    await page.route("**/api/auth/refresh", (route) => fulfillJson(route, 401, {}));
    await page.goto("/auth/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await runAudit(page);
  });
});
