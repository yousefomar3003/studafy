import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * End-to-end coverage for discipline management (ST-197): a teacher-reported incident moving
 * through the principal's inbox — triage, recording an action, and resolving it — against a
 * stubbed backend, the same approach as `announcement-management.spec.ts`, no Postgres or
 * `apps/api` process required.
 *
 * This proves the UI enforces its own resolution-requires-an-action rule (the Resolve button stays
 * disabled until an action exists, matching `IncidentDetailPage.tsx`'s gating) and constructs the
 * right requests for each step. It does not, and cannot, prove the API itself would accept or reject
 * these calls — that's `apps/api/src/modules/discipline/__tests__/discipline.test.ts`'s job.
 */

const NOW = "2026-08-18T09:00:00.000Z";

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

const INCIDENT_ID = "incident-1";

function buildIncident(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

/** Stubs `GET/PATCH /api/discipline/incidents...`, `GET/POST .../actions`, and
 * `POST .../resolve` against one mutable incident — enough state to exercise
 * "teacher-reported → triage → add action → resolve" without a real database. */
async function stubDisciplineBackend(page: Page) {
  let incident = buildIncident();
  const actions: Record<string, unknown>[] = [];

  const pathIs = (url: string, pathname: string) => new URL(url).pathname === pathname;

  await page.route("**/api/schools/current/settings", (route) =>
    fulfillJson(route, 200, { parent_discipline_visibility: true }),
  );

  await page.route("**/api/discipline/incidents**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (pathIs(url, "/api/discipline/incidents") && method === "GET") {
      const status = new URL(url).searchParams.get("status");
      const matches = status ? incident.status === status : true;
      return fulfillJson(route, 200, {
        incidents: matches ? [incident] : [],
        total: matches ? 1 : 0,
      });
    }

    if (pathIs(url, `/api/discipline/incidents/${INCIDENT_ID}`) && method === "GET") {
      return fulfillJson(route, 200, incident);
    }

    if (pathIs(url, `/api/discipline/incidents/${INCIDENT_ID}/actions`) && method === "GET") {
      return fulfillJson(route, 200, { actions, total: actions.length });
    }

    if (pathIs(url, `/api/discipline/incidents/${INCIDENT_ID}/actions`) && method === "POST") {
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

    if (pathIs(url, `/api/discipline/incidents/${INCIDENT_ID}/resolve`) && method === "POST") {
      incident = { ...incident, status: "resolved", resolved_at: NOW };
      return fulfillJson(route, 200, incident);
    }

    return route.fallback();
  });
}

test.describe("discipline management", () => {
  test("triages a teacher-reported incident: records an action, then resolves it", async ({
    page,
  }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page, ["ORG_ADMIN"]);
    await stubDisciplineBackend(page);

    await page.goto("/portal/principal/discipline");

    await expect(page.getByRole("heading", { name: "Discipline incidents" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Teacher-reported inbox" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page.getByRole("link", { name: "Cafeteria altercation" }).click();
    await expect(page.getByRole("heading", { name: "Cafeteria altercation" })).toBeVisible();

    const resolveButton = page.getByRole("button", { name: "Resolve" });
    await expect(resolveButton).toBeDisabled();
    await expect(
      page.getByText("Record at least one disciplinary action before resolving this incident."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add action" }).click();
    const actionDialog = page.getByRole("dialog", { name: "Record a disciplinary action" });
    await actionDialog.getByRole("combobox", { name: "Action type" }).click();
    await page.getByRole("option", { name: "Detention" }).click();
    await actionDialog.getByLabel("Details").fill("One week detention.");

    const createActionRequest = page.waitForRequest(
      (req) =>
        req.url().includes(`/api/discipline/incidents/${INCIDENT_ID}/actions`) &&
        req.method() === "POST",
    );
    await actionDialog.getByRole("button", { name: "Record action" }).click();
    const actionRequest = await createActionRequest;
    expect(actionRequest.postDataJSON()).toMatchObject({
      action_type: "detention",
      description: "One week detention.",
    });

    await expect(page.getByText("Action recorded")).toBeVisible();
    await expect(resolveButton).toBeEnabled();

    await resolveButton.click();
    const resolveDialog = page.getByRole("dialog", { name: "Resolve incident" });
    await resolveDialog
      .getByLabel("Resolution notes")
      .fill("Parent met with principal; detention served.");

    const resolveRequest = page.waitForRequest(
      (req) =>
        req.url().includes(`/api/discipline/incidents/${INCIDENT_ID}/resolve`) &&
        req.method() === "POST",
    );
    await resolveDialog.getByRole("button", { name: "Resolve" }).click();
    const request = await resolveRequest;
    expect(request.postDataJSON()).toMatchObject({
      resolution_description: "Parent met with principal; detention served.",
    });

    await expect(page.getByText("Incident resolved")).toBeVisible();
    await expect(page.getByText("Resolved", { exact: true })).toBeVisible();
    await expect(page.getByText("Visible to the student's parent")).toBeVisible();
  });
});
