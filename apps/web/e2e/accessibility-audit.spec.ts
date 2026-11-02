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
    await stubAuthenticatedSession(page, ["PRINCIPAL"]);
    await stubNotifications(page);

    await page.goto("/portal/notifications");
    await expect(page.getByText("Algebra homework due")).toBeVisible();
    await runAudit(page);
  });

  test("preferences has no critical/serious violations", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["PRINCIPAL"]);
    await stubNotifications(page);

    await page.goto("/portal/notifications/preferences");
    await expect(page.getByRole("heading", { name: "Notification settings" })).toBeVisible();
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
// Student import history, one import's unused columns with the mapping preview open, and the
// platform's unused-column count.
// ---------------------------------------------------------------------------

test.describe("student import history", () => {
  const IMPORT_ID = "11111111-1111-4111-8111-111111111111";
  const IMPORT = {
    id: IMPORT_ID,
    school_id: "school-1",
    uploaded_by: "user-1",
    confirmed_by: "user-1",
    status: "completed",
    file_name: "sis-export.csv",
    row_count: 3,
    valid_rows: 3,
    error_rows: 0,
    header_line: 1,
    source_headers: ["Student ID", "First", "Last", "Civil ID", "Bus stop"],
    column_mapping: { admission_number: "Student ID", first_name: "First", last_name: "Last" },
    errors: [],
    summary: {
      students_created: 2,
      students_updated: 1,
      students_skipped: 0,
      parents_created: 0,
      parents_linked: 0,
    },
    created_at: NOW,
    updated_at: NOW,
    confirmed_at: NOW,
    completed_at: NOW,
    source_file: {
      file_name: "sis-export.csv",
      size_bytes: 2048,
      uploaded_at: NOW,
      stored: true,
      expires_at: "2027-02-19T09:00:00.000Z",
      removed_at: null,
      removed_reason: null,
    },
    uploaded_by_name: "Amal Admin",
    confirmed_by_name: "Amal Admin",
    unmapped_column_count: 2,
    cells_available: true,
  };
  const COLUMNS = {
    import_id: IMPORT_ID,
    status: "completed",
    cells_available: true,
    can_apply: true,
    cells_expire_at: "2027-02-19T09:00:00.000Z",
    columns: [
      {
        position: 3,
        header: "Civil ID",
        non_empty_count: 3,
        student_count: 3,
        parent_count: 0,
        suggested_field_type: "short_text",
        suggested_options: [],
        suggested_sensitive: true,
        sensitive_reason: "label",
        applied: null,
      },
      {
        position: 4,
        header: "Bus stop",
        non_empty_count: 2,
        student_count: 2,
        parent_count: 0,
        suggested_field_type: "short_text",
        suggested_options: [],
        suggested_sensitive: false,
        sensitive_reason: null,
        applied: null,
      },
    ],
  };
  const PREVIEW = {
    import_id: IMPORT_ID,
    position: 3,
    header: "Civil ID",
    subject_kind: "student",
    field: {
      id: null,
      field_type: "short_text",
      label_en: "Civil ID",
      label_ar: "Civil ID",
      sensitivity: "sensitive",
    },
    totals: { write: 2, unchanged: 0, kept: 0, invalid: 1, empty: 0, conflict: 0 },
    rows: [
      {
        line_number: 2,
        subject_id: "s-1",
        name: "Rana Haddad",
        admission_number: "S-1",
        status: "write",
        replaces_existing: false,
        value: null,
        mask: "•••• 2345",
        current_value: null,
        current_mask: null,
        reason: null,
      },
      {
        line_number: 4,
        subject_id: "s-3",
        name: "Huda Saleh",
        admission_number: "S-3",
        status: "invalid",
        replaces_existing: false,
        value: null,
        mask: null,
        current_value: null,
        current_mask: null,
        reason: "RECORD_VALUE_TOO_LONG",
      },
    ],
    preview_token: "a".repeat(64),
  };

  async function stubImports(page: Page) {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
    await page.route("**/api/record-forms/**", (route) =>
      fulfillJson(route, 200, { subject_kind: "student", version: 0, fields: [] }),
    );
    await page.route("**/api/imports/students**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/imports/students") {
        return fulfillJson(route, 200, { imports: [IMPORT], next_cursor: null });
      }
      if (pathname.endsWith("/settings")) {
        return fulfillJson(route, 200, {
          source_retention_days: 180,
          default_retention_days: 180,
          max_retention_days: 180,
          updated_at: null,
        });
      }
      if (pathname.endsWith("/columns/preview")) return fulfillJson(route, 200, PREVIEW);
      if (pathname.endsWith("/columns")) return fulfillJson(route, 200, COLUMNS);
      return fulfillJson(route, 200, IMPORT);
    });
  }

  test("history has no critical/serious violations", async ({ page }) => {
    await stubImports(page);
    await page.goto("/portal/admin/students/imports");
    await expect(page.getByRole("heading", { name: "Import history", level: 1 })).toBeVisible();
    await expect(page.getByRole("table", { name: "Student imports" })).toBeVisible();
    await runAudit(page);
  });

  test("the column mapping preview has no critical/serious violations", async ({ page }) => {
    await stubImports(page);
    await page.goto(`/portal/admin/students/imports/${IMPORT_ID}`);
    await page.getByRole("button", { name: "Map column Civil ID" }).click();
    const dialog = page.getByRole("dialog", { name: "Map “Civil ID”" });
    await dialog.getByRole("button", { name: "Preview" }).click();
    await expect(dialog.getByRole("table", { name: "What “Civil ID” would write" })).toBeVisible();
    await runAudit(page);
  });

  test("the platform's unused-column count has no critical/serious violations", async ({
    page,
  }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["SUPER_ADMIN"]);
    await page.route("**/api/platform/import-signals/unmapped-headers", (route) =>
      fulfillJson(route, 200, {
        min_schools: 3,
        headers: [{ normalized_header: "bloodtype", header: "Blood Type", schools: 7, imports: 9 }],
      }),
    );
    await page.goto("/portal/platform/import-signals");
    await expect(page.getByRole("table", { name: "Unused column headers" })).toBeVisible();
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

test.describe("staff and class records", () => {
  const field = (overrides: Record<string, unknown>) => ({
    help_en: null,
    help_ar: null,
    required: false,
    options: [],
    sort_order: 0,
    visibility: "staff_only",
    sensitivity: "standard",
    has_expiry: false,
    ...overrides,
  });
  const entry = (definition: Record<string, unknown>, overrides: Record<string, unknown>) => ({
    field: definition,
    archived: false,
    value: null,
    masked: false,
    mask: null,
    answered: false,
    missing: false,
    answered_in_version: 1,
    answered_field: null,
    document: null,
    updated_at: NOW,
    ...overrides,
  });
  const STAFF_RECORDS = {
    subject_kind: "staff",
    subject_id: "user-2",
    template_version: 1,
    missing_required: 1,
    entries: [
      entry(
        field({
          id: "f-qual",
          field_type: "short_text",
          label_en: "Qualification",
          label_ar: "المؤهل",
        }),
        { value: "BEd Mathematics", answered: true },
      ),
      entry(
        field({
          id: "f-salary",
          field_type: "short_text",
          label_en: "Monthly salary",
          label_ar: "الراتب الشهري",
          sensitivity: "sensitive",
          required: true,
        }),
        { masked: true, mask: "•••• JOD", answered: true },
      ),
      entry(
        field({
          id: "f-licence",
          field_type: "document",
          label_en: "Teaching licence",
          label_ar: "رخصة التعليم",
          required: true,
        }),
        { missing: true, answered_in_version: null, updated_at: null },
      ),
    ],
  };
  const CLASS_RECORDS = {
    subject_kind: "class",
    subject_id: "class-1",
    template_version: 1,
    missing_required: 0,
    entries: [
      entry(
        field({
          id: "f-bus",
          field_type: "short_text",
          label_en: "Bus group",
          label_ar: "مجموعة الحافلة",
          visibility: "teachers",
        }),
        { value: "Route 4", answered: true },
      ),
    ],
  };

  async function stubRecords(page: Page, roles: string[]) {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, roles);
    await page.route("**/api/users/user-2", (route) =>
      fulfillJson(route, 200, { id: "user-2", display_name: "Lina Saleh", email: "lina@x.edu" }),
    );
    await page.route("**/api/staff/user-2/records", (route) =>
      fulfillJson(route, 200, STAFF_RECORDS),
    );
    await page.route("**/api/academics/classes/class-1", (route) =>
      fulfillJson(route, 200, { id: "class-1", code: "CLS-10A" }),
    );
    await page.route("**/api/classes/class-1/records", (route) =>
      fulfillJson(route, 200, CLASS_RECORDS),
    );
    await page.route("**/api/records/missing/**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.endsWith("/staff")) {
        return fulfillJson(route, 200, {
          staff: [
            {
              user_id: "user-2",
              name: "Lina Saleh",
              email: "lina@x.edu",
              missing: [
                {
                  field_id: "f-licence",
                  label_en: "Teaching licence",
                  label_ar: "رخصة التعليم",
                  expires_on: null,
                },
              ],
              expired: [],
              expiring: [],
            },
          ],
          total: 1,
          issue: "all",
        });
      }
      if (pathname.endsWith("/classes")) {
        return fulfillJson(route, 200, { classes: [], total: 0, issue: "all" });
      }
      if (pathname.endsWith("/students")) {
        return fulfillJson(route, 200, { students: [], total: 0, issue: "all" });
      }
      if (pathname.endsWith("/parents")) {
        return fulfillJson(route, 200, { parents: [], total: 0, issue: "all" });
      }
      return fulfillJson(route, 200, {
        students: 0,
        parents: 0,
        expired_documents: 0,
        expiring_documents: 0,
      });
    });
  }

  test("a staff record has no critical/serious violations", async ({ page }) => {
    await stubRecords(page, ["ORG_ADMIN"]);
    await page.goto("/portal/admin/staff/user-2/records");
    await expect(
      page.getByRole("heading", { name: "Lina Saleh: staff record", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Reveal Monthly salary" })).toBeVisible();
    await runAudit(page);
  });

  test("a class record has no critical/serious violations", async ({ page }) => {
    await stubRecords(page, ["PRINCIPAL"]);
    await page.goto("/portal/principal/classes/class-1/records");
    await expect(
      page.getByRole("heading", { name: "CLS-10A: class record", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Route 4")).toBeVisible();
    await runAudit(page);
  });

  test("my own staff record has no critical/serious violations", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["FINANCE"]);
    await page.route("**/api/me/staff-record", (route) =>
      fulfillJson(route, 200, {
        ...STAFF_RECORDS,
        entries: STAFF_RECORDS.entries.filter(
          (item) => (item.field as { sensitivity: string }).sensitivity !== "sensitive",
        ),
      }),
    );
    await page.goto("/account/staff-record");
    await expect(page.getByRole("heading", { name: "My staff record", level: 1 })).toBeVisible();
    await expect(page.getByText("BEd Mathematics")).toBeVisible();
    await runAudit(page);
  });

  test("the staff tab of missing information has no critical/serious violations", async ({
    page,
  }) => {
    await stubRecords(page, ["ORG_ADMIN"]);
    await page.goto("/portal/admin/records/missing");
    await page.getByRole("tab", { name: "Staff" }).click();
    await expect(page.getByRole("link", { name: "Open Lina Saleh's record" })).toBeVisible();
    await runAudit(page);
  });
});

// ---------------------------------------------------------------------------
// Custom lists -- the index, one list's table, the add-row dialog with its link picker, and a
// sheet previewed as a new list.
// ---------------------------------------------------------------------------

test.describe("custom lists", () => {
  const LIST_ID = "11111111-1111-4111-8111-111111111111";
  const column = (overrides: Record<string, unknown>) => ({
    required: false,
    sensitivity: "standard",
    sort_order: 0,
    archived: false,
    options: [],
    ...overrides,
  });
  const SUMMARY = {
    id: LIST_ID,
    name_en: "Lockers",
    name_ar: "الخزائن",
    description: "Who has which locker.",
    audience: "leadership",
    links: { student: true, parent: false, staff: false, class: false },
    archived: false,
    row_count: 1,
    column_count: 3,
    can_manage: true,
    created_at: NOW,
    updated_at: NOW,
  };
  const DETAIL = {
    ...SUMMARY,
    columns: [
      column({
        id: "col-locker",
        field_type: "short_text",
        label_en: "Locker",
        label_ar: "الخزانة",
      }),
      column({
        id: "col-issued",
        field_type: "date",
        label_en: "Issued on",
        label_ar: "تاريخ التسليم",
        sort_order: 1,
      }),
      column({
        id: "col-code",
        field_type: "short_text",
        label_en: "Combination",
        label_ar: "الرمز",
        sensitivity: "sensitive",
        sort_order: 2,
      }),
    ],
  };
  const ROW = {
    id: "row-1",
    link: { kind: "student", id: "student-1", name: "Amara Chen" },
    cells: [
      { column_id: "col-locker", value: "B-12", masked: false, mask: null },
      { column_id: "col-issued", value: "2026-09-01T00:00:00.000Z", masked: false, mask: null },
      { column_id: "col-code", value: null, masked: true, mask: "••••" },
    ],
    created_at: NOW,
    updated_at: NOW,
  };
  const PREVIEW = {
    header_line: 1,
    row_count: 2,
    columns: [
      {
        index: 0,
        header: "Admission No",
        include: true,
        label_en: "Admission No",
        label_ar: "Admission No",
        field_type: "short_text",
        guessed_type: "short_text",
        sensitivity: "standard",
        suggested_sensitive: false,
        options: [],
        sample: ["ADM-0001", "NOPE-9"],
        invalid_count: 0,
        invalid_lines: [],
      },
      {
        index: 1,
        header: "Book",
        include: true,
        label_en: "Book",
        label_ar: "Book",
        field_type: "short_text",
        guessed_type: "short_text",
        sensitivity: "standard",
        suggested_sensitive: false,
        options: [],
        sample: ["Dune", "Emma"],
        invalid_count: 0,
        invalid_lines: [],
      },
    ],
    rows: [
      {
        line: 2,
        key: "ADM-0001",
        status: "linked",
        reason: null,
        link: { kind: "student", id: "student-1", name: "Amara Chen" },
      },
      { line: 3, key: "NOPE-9", status: "unmatched", reason: "NO_MATCH", link: null },
    ],
    totals: { rows: 2, linked: 1, unmatched: 1, skipped: 0, invalid_cells: 0 },
    links: { student: true, parent: false, staff: false, class: false },
    preview_token: "a".repeat(64),
  };

  async function stubLists(page: Page, roles: string[]) {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, roles);
    await page.route("**/api/custom-lists**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/custom-lists") {
        return fulfillJson(route, 200, {
          lists: [SUMMARY],
          limits: { lists: 50, columns_per_list: 30, rows_per_list: 5000, rows_per_school: 20000 },
        });
      }
      if (pathname === "/api/custom-lists/imports/preview") return fulfillJson(route, 200, PREVIEW);
      if (pathname.endsWith("/rows")) {
        return fulfillJson(route, 200, { rows: [ROW], total: 1, limit: 25, offset: 0 });
      }
      if (pathname.endsWith("/link-candidates")) {
        return fulfillJson(route, 200, {
          candidates: [{ id: "student-2", name: "Bilal Omari", detail: "ADM-0042" }],
        });
      }
      return fulfillJson(route, 200, DETAIL);
    });
  }

  test("the lists index has no critical/serious violations", async ({ page }) => {
    await stubLists(page, ["ORG_ADMIN"]);
    await page.goto("/portal/lists");
    await expect(page.getByRole("heading", { name: "Lists", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Lockers" })).toBeVisible();
    await runAudit(page);
  });

  test("a list's table has no critical/serious violations", async ({ page }) => {
    await stubLists(page, ["PRINCIPAL"]);
    await page.goto(`/portal/lists/${LIST_ID}`);
    await expect(page.getByRole("heading", { name: "Lockers", level: 1 })).toBeVisible();
    await expect(page.getByText("B-12")).toBeVisible();
    await expect(page.getByText("••••")).toBeVisible();
    await runAudit(page);
  });

  test("the add-row dialog and its link picker have no critical/serious violations", async ({
    page,
  }) => {
    await stubLists(page, ["ORG_ADMIN"]);
    await page.goto(`/portal/lists/${LIST_ID}`);
    await expect(page.getByText("B-12")).toBeVisible();
    await page.getByRole("button", { name: "Add row" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a row to Lockers" });
    await dialog.getByLabel("Find a Student").fill("Bil");
    await expect(dialog.getByText("Bilal Omari · ADM-0042")).toBeVisible();
    await runAudit(page);
  });

  test("a sheet previewed as a new list has no critical/serious violations", async ({ page }) => {
    await stubLists(page, ["ORG_ADMIN"]);
    await page.goto("/portal/lists/import");
    await expect(
      page.getByRole("heading", { name: "Create a list from a spreadsheet", level: 1 }),
    ).toBeVisible();
    await page.getByLabel("CSV file").setInputFiles({
      name: "library-loans.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Admission No,Book\nADM-0001,Dune\nNOPE-9,Emma\n"),
    });
    await page.getByLabel("List name (English)").fill("Library loans");
    await page.getByLabel("List name (Arabic)").fill("إعارات المكتبة");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByText("Amara Chen")).toBeVisible();
    await runAudit(page);
  });
});
