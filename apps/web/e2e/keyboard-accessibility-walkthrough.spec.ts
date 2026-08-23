import { expect, test } from "@playwright/test";

import type { Locator, Page, Route } from "@playwright/test";

/**
 * ST-211's keyboard-only walkthrough of 5 core journeys: every interaction below is a keyboard
 * event (`Tab`/`Shift+Tab`/`Enter`/`Space`/arrow keys/typed characters/`Escape`) — this file never
 * calls `.click()`. Each journey also proves the two things a mouse-driven test cannot: that every
 * control is reachable in forward tab order (`tabTo` fails the test if it isn't, rather than
 * silently skipping ahead), and that opening/closing a dialog traps and then restores focus
 * correctly (`@studafy/ui`'s `useFocusTrap` — see its own doc comment — returns focus to whatever
 * was focused before the dialog opened, which `tabTo` naturally leaves as the trigger).
 *
 * `video: "on"` (below) records every run, satisfying the acceptance criterion's "recorded" —
 * Playwright writes each journey's video under `test-results/<test-name>/video.webm`; `bun run e2e
 * --reporter=html` bundles them into a browsable report instead.
 *
 * Stub shapes mirror the existing e2e specs in this directory (`payment-recording.spec.ts`,
 * `discipline-management.spec.ts`, `audit-log-explorer.spec.ts`) — same no-Postgres, routed-fetch
 * approach, no new pattern introduced.
 */

test.use({ video: "on" });

const NOW = "2026-08-23T09:00:00.000Z";

function fakeAccessToken(roles: string[]): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256" })}.${segment({ sub: "user-1", roles })}.signature`;
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

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

/** Presses `Tab` until `locator` is the focused element, and never clicks it — the whole point of a
 * keyboard-only walkthrough. Fails loudly (rather than hanging or silently giving up) if the
 * control turns out to be unreachable within a generous cap, which is exactly the "focus order"
 * regression this walkthrough exists to catch. */
async function tabTo(page: Page, locator: Locator, maxPresses = 50): Promise<void> {
  for (let presses = 0; presses <= maxPresses; presses++) {
    if (await locator.evaluate((el) => el === document.activeElement).catch(() => false)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(
    `Not reachable via Tab within ${maxPresses} presses: ${await locator.toString()}`,
  );
}

/** `useFocusTrap` moves focus in a `useEffect`, which fires a tick after the dialog paints — so
 * this must poll rather than read `document.activeElement` once. `toBeFocused()` does that. */
async function expectFocused(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
}

// ---------------------------------------------------------------------------
// Journey 1 — Principal: review and approve an item from the approval queue.
// Exercises: table row actions in tab order, a modal's focus trap, Escape-to-close restoring
// focus to the trigger, and a second control (Approve) activated with Enter.
// ---------------------------------------------------------------------------

test("journey 1 — approve a pending item from the approval queue, keyboard only", async ({
  page,
}) => {
  await stubPortalShellDefaults(page);
  await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
  await page.route("**/api/approvals/queue**", (route) =>
    fulfillJson(route, 200, {
      items: [
        {
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
        },
      ],
      total: 1,
    }),
  );
  await page.route("**/api/approvals/bulk-decision", (route) =>
    fulfillJson(route, 200, {
      results: [{ id: "item-a", item_type: "grade_submission", error: null }],
      summary: { total: 1, succeeded: 1, failed: 0 },
    }),
  );

  await page.goto("/portal/approvals");
  await expect(page.getByText("Grade 9 Math — Q3 midterm")).toBeVisible();

  const viewDiff = page.getByRole("button", { name: "View diff" });
  await tabTo(page, viewDiff);
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "What changed" });
  await expect(dialog).toBeVisible();
  // The focus trap parks focus on the dialog's content, not its header — `useFocusTrap` skips the
  // close button for the default target (see its own doc comment), so this lands on the diff
  // table's scrollable region (`Table`'s own `tabIndex={0}` wrapper), the first focusable element
  // that is actually part of what this dialog is showing.
  await expectFocused(dialog.getByRole("region", { name: /Grades in this submission/ }));

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // ... and returns it to the exact control that opened it, not just "somewhere on the page".
  await expectFocused(viewDiff);

  // `exact: true` matters: the toolbar also has an "Approve selected" button, and Playwright's
  // default substring name match would make this locator ambiguous (a strict-mode violation that
  // `tabTo`'s `.catch(() => false)` would silently read as "not focused yet", exhausting every Tab
  // press before failing with a misleading "not reachable").
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await tabTo(page, approve);
  await page.keyboard.press("Enter");

  await expect(page.getByText("Item approved")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Journey 2 — Any user: read a notification, then reach and change a channel preference.
// Exercises: an inline action button, cross-page link navigation, a table of checkboxes (arrow-free
// — each cell tabs individually, per the ARIA "grid of independent checkboxes" pattern this table
// uses), and a Space-toggled checkbox.
// ---------------------------------------------------------------------------

test("journey 2 — read a notification, then change a channel preference, keyboard only", async ({
  page,
}) => {
  await stubPortalShellDefaults(page);
  await stubAuthenticatedSession(page, ["STUDENT"]);

  let readCalled = false;
  await page.route("**/api/notifications/n-1/read", (route) => {
    readCalled = true;
    return fulfillJson(route, 200, {});
  });
  await page.route("**/api/notifications/unread-count", (route) =>
    fulfillJson(route, 200, { unread_count: readCalled ? 0 : 1 }),
  );
  await page.route("**/api/notifications**", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/notifications") return route.fallback();
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
          read_at: readCalled ? NOW : null,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
  });
  await page.route("**/api/notification-preferences", async (route) => {
    if (route.request().method() === "PATCH") return fulfillJson(route, 200, {});
    return fulfillJson(route, 200, {
      attendance_alert_threshold: null,
      preferences: ["in_app", "push", "email"].map((channel) => ({
        notification_type: "ASSIGNMENT_DUE_SOON",
        channel,
        enabled: true,
        digest: false,
        mandatory: false,
        digest_eligible: channel === "email",
      })),
    });
  });

  await page.goto("/portal/notifications");
  await expect(page.getByText("Algebra homework due")).toBeVisible();

  const markAsRead = page.getByRole("button", { name: "Mark as read" });
  await tabTo(page, markAsRead);
  const readRequest = page.waitForRequest(
    (req) => req.url().endsWith("/api/notifications/n-1/read") && req.method() === "POST",
  );
  await page.keyboard.press("Enter");
  // The inbox list is locally paginated state, not a react-query cache entry (see
  // `useCursorPagination`'s own doc comment) — marking read invalidates the unread-count query
  // but does not refetch this list, so the row stays put until the next natural reload. That is
  // this page's existing behavior, unrelated to accessibility; the keyboard-only claim this journey
  // is making is only that the button is reachable and activatable without a mouse.
  await readRequest;

  const settingsLink = page.getByRole("link", { name: "Notification settings" });
  await tabTo(page, settingsLink);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Notification settings" })).toBeVisible();

  const pushToggle = page.getByRole("checkbox", { name: "Assignment due soon — Push" });
  await tabTo(page, pushToggle);
  await expect(pushToggle).toBeChecked();
  await page.keyboard.press("Space");
  await expect(pushToggle).not.toBeChecked();

  const save = page.getByRole("button", { name: "Save channel preferences" });
  await tabTo(page, save);
  await page.keyboard.press("Enter");

  await expect(page.getByText("Notification preferences updated")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Journey 3 — Org admin: invite a new user by email.
// Exercises: a modal with an autofocused first field, typed input, the design system's ARIA 1.2
// combobox (opened and committed with the keyboard, never a mouse-driven option click), and a
// second modal chained off the first one's success.
// ---------------------------------------------------------------------------

test("journey 3 — invite a user through the New invitation modal, keyboard only", async ({
  page,
}) => {
  await stubPortalShellDefaults(page);
  await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
  await page.route("**/api/invitations**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return fulfillJson(route, 200, { invitations: [], next_cursor: null, bulk_invites: [] });
  });
  await page.route("**/api/invitations", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { email: string; role: string };
    expect(body).toMatchObject({ email: "morgan@example.edu", role: "STUDENT" });
    return fulfillJson(route, 201, {
      invitation: { email: body.email, role: body.role },
      token: "tok_abc123",
    });
  });

  await page.goto("/portal/admin/invitations");
  await expect(page.getByRole("heading", { name: "Invitations" })).toBeVisible();

  const newInvitation = page.getByRole("button", { name: "New invitation" });
  await tabTo(page, newInvitation);
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "New invitation" });
  await expect(dialog).toBeVisible();

  // The email field is the dialog's first focusable content (the trap skips the header's close
  // button for its default target — see `useFocusTrap`'s doc comment) — no Tab needed to reach it.
  const emailField = dialog.getByLabel("Email");
  await expectFocused(emailField);
  await page.keyboard.type("morgan@example.edu");

  const roleSelect = dialog.getByRole("combobox", { name: "Role" });
  await tabTo(page, roleSelect);
  // Typeahead: "S" opens the listbox and jumps straight to "Student" (the only invitation role
  // starting with S), then Enter commits it — the combobox's documented keyboard model.
  await page.keyboard.press("s");
  await expect(roleSelect).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(roleSelect).toHaveText("Student");

  const sendInvite = dialog.getByRole("button", { name: "Send invite" });
  await tabTo(page, sendInvite);
  await page.keyboard.press("Enter");

  const linkDialog = page.getByRole("dialog", { name: "Invitation sent" });
  await expect(linkDialog).toBeVisible();
  const done = linkDialog.getByRole("button", { name: "Done" });
  await tabTo(page, done);
  await page.keyboard.press("Enter");
  await expect(linkDialog).toBeHidden();
});

// ---------------------------------------------------------------------------
// Journey 4 — Finance: record a payment against an invoice.
// Exercises: a search-and-pick pattern (type to filter, then activate a result button), a text
// field, a radio group (arrow-key selection per the native radio keyboard model), and a submit that
// leaves the record-a-payment flow.
// ---------------------------------------------------------------------------

test("journey 4 — record a payment against an invoice, keyboard only", async ({ page }) => {
  await stubPortalShellDefaults(page);
  await stubAuthenticatedSession(page, ["FINANCE"]);

  const invoice = {
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
  };

  await page.route("**/api/finance/invoices**", async (route) => {
    const url = route.request().url();
    if (new URL(url).pathname === "/api/finance/invoices" && route.request().method() === "GET") {
      return fulfillJson(route, 200, { invoices: [invoice], next_cursor: null });
    }
    return route.fallback();
  });
  await page.route("**/api/finance/payments**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (new URL(url).pathname === "/api/finance/payments" && method === "POST") {
      return fulfillJson(route, 201, {
        id: "payment-1",
        school_id: "school-1",
        student_id: "student-1",
        erpnext_payment_entry_id: null,
        erpnext_invoice_id: "ACC-SINV-2026-00001",
        amount: "500",
        amount_minor: 500000,
        currency: "JOD",
        currency_minor_unit: 3,
        payment_mode: "cash",
        status: "pending",
        erpnext_status: "Draft",
        receipt_url: null,
        payment_date: "2026-08-23",
        confirmed_at: null,
        last_synced_at: NOW,
      });
    }
    if (new URL(url).pathname === "/api/finance/payments/payment-1" && method === "GET") {
      return fulfillJson(route, 200, {
        id: "payment-1",
        school_id: "school-1",
        student_id: "student-1",
        erpnext_payment_entry_id: null,
        erpnext_invoice_id: "ACC-SINV-2026-00001",
        amount: "500",
        amount_minor: 500000,
        currency: "JOD",
        currency_minor_unit: 3,
        payment_mode: "cash",
        status: "confirmed",
        erpnext_status: "Submitted",
        receipt_url: "https://erpnext.example.com/receipts/payment-1",
        payment_date: "2026-08-23",
        confirmed_at: NOW,
        last_synced_at: NOW,
      });
    }
    return route.fallback();
  });

  await page.goto("/portal/finance/payments/new");
  await expect(page.getByRole("heading", { name: "Record a payment" })).toBeVisible();

  const invoiceSearch = page.getByLabel("Invoice", { exact: false });
  await tabTo(page, invoiceSearch);
  await page.keyboard.type("Layla");

  const invoiceResult = page.getByRole("button", { name: /ACC-SINV-2026-00001/ });
  await tabTo(page, invoiceResult);
  await page.keyboard.press("Enter");

  const amountField = page.getByLabel("Amount", { exact: false });
  await tabTo(page, amountField);
  await amountField.press("Control+a");
  await page.keyboard.type("500");

  const cashOption = page.getByRole("radio", { name: "Cash" });
  await tabTo(page, cashOption);
  await page.keyboard.press("Space");
  await expect(cashOption).toBeChecked();

  await expect(
    page.getByText("Partial payment — 500.000 JOD will remain outstanding."),
  ).toBeVisible();

  const submit = page.getByRole("button", { name: "Record payment" });
  await tabTo(page, submit);
  await page.keyboard.press("Enter");

  await expect(page.getByText("Payment recorded — 500 JOD")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Journey 5 — Principal: triage a discipline incident (add an action, then resolve it).
// Exercises: navigating into a detail view via a link, a second ARIA combobox (typeahead again), a
// textarea, and a second dialog opened only once the first workflow step unblocks it.
// ---------------------------------------------------------------------------

test("journey 5 — record a disciplinary action and resolve the incident, keyboard only", async ({
  page,
}) => {
  await stubPortalShellDefaults(page);
  await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
  await page.route("**/api/schools/current/settings", (route) =>
    fulfillJson(route, 200, { parent_discipline_visibility: true }),
  );

  const INCIDENT_ID = "incident-1";
  let incident = {
    id: INCIDENT_ID,
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
  };
  const actions: Record<string, unknown>[] = [];

  await page.route("**/api/discipline/incidents**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const pathIs = (pathname: string) => new URL(url).pathname === pathname;

    if (pathIs("/api/discipline/incidents") && method === "GET") {
      const status = new URL(url).searchParams.get("status");
      const matches = status ? incident.status === status : true;
      return fulfillJson(route, 200, {
        incidents: matches ? [incident] : [],
        total: matches ? 1 : 0,
      });
    }
    if (pathIs(`/api/discipline/incidents/${INCIDENT_ID}`) && method === "GET") {
      return fulfillJson(route, 200, incident);
    }
    if (pathIs(`/api/discipline/incidents/${INCIDENT_ID}/actions`) && method === "GET") {
      return fulfillJson(route, 200, { actions, total: actions.length });
    }
    if (pathIs(`/api/discipline/incidents/${INCIDENT_ID}/actions`) && method === "POST") {
      const body = route.request().postDataJSON() as { action_type: string; description?: string };
      const action = {
        id: "action-1",
        school_id: "school-1",
        incident_id: INCIDENT_ID,
        action_type: body.action_type,
        action_by_user_id: "admin-1",
        status: "pending",
        description: body.description ?? null,
        effective_from: null,
        effective_until: null,
        created_at: NOW,
        updated_at: NOW,
      };
      actions.push(action);
      return fulfillJson(route, 201, action);
    }
    if (pathIs(`/api/discipline/incidents/${INCIDENT_ID}/resolve`) && method === "POST") {
      incident = { ...incident, status: "resolved", resolved_at: NOW };
      return fulfillJson(route, 200, incident);
    }
    return route.fallback();
  });

  await page.goto("/portal/principal/discipline");
  await expect(page.getByRole("heading", { name: "Discipline incidents" })).toBeVisible();

  const incidentLink = page.getByRole("link", { name: "Cafeteria altercation" });
  await tabTo(page, incidentLink);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Cafeteria altercation" })).toBeVisible();

  const resolveButton = page.getByRole("button", { name: "Resolve" });
  await expect(resolveButton).toBeDisabled();

  const addAction = page.getByRole("button", { name: "Add action" });
  await tabTo(page, addAction);
  await page.keyboard.press("Enter");

  const actionDialog = page.getByRole("dialog", { name: "Record a disciplinary action" });
  await expect(actionDialog).toBeVisible();

  const actionType = actionDialog.getByRole("combobox", { name: "Action type" });
  await tabTo(page, actionType);
  // Typeahead again: "d" is unique to "Detention" among the action-type options.
  await page.keyboard.press("d");
  await expect(actionType).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(actionType).toHaveText("Detention");

  const details = actionDialog.getByLabel("Details");
  await tabTo(page, details);
  await page.keyboard.type("One week detention.");

  const recordAction = actionDialog.getByRole("button", { name: "Record action" });
  await tabTo(page, recordAction);
  await page.keyboard.press("Enter");

  await expect(page.getByText("Action recorded")).toBeVisible();
  await expect(resolveButton).toBeEnabled();

  await tabTo(page, resolveButton);
  await page.keyboard.press("Enter");

  const resolveDialog = page.getByRole("dialog", { name: "Resolve incident" });
  await expect(resolveDialog).toBeVisible();

  const resolutionNotes = resolveDialog.getByLabel("Resolution notes");
  await tabTo(page, resolutionNotes);
  await page.keyboard.type("Parent met with principal; detention served.");

  const confirmResolve = resolveDialog.getByRole("button", { name: "Resolve" });
  await tabTo(page, confirmResolve);
  await page.keyboard.press("Enter");

  await expect(page.getByText("Incident resolved")).toBeVisible();
});
