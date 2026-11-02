import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * End-to-end coverage for the user-management screens (ST-187): list, create, edit (incl. role
 * assignment), and deactivate, against a stubbed backend — the same approach as
 * `onboarding-setup.spec.ts`, no Postgres or `apps/api` process required.
 *
 * The route lives inside `PortalLayout` (header, sidebar, notification bell), unlike the wizard
 * specs, so a broad catch-all stub is registered first for whatever else the shell fetches on
 * mount; the specific handlers below are registered after and take precedence (Playwright matches
 * routes last-registered-first).
 */

function fakeAccessToken(roles: string[]): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256" })}.${segment({ sub: "admin-1", roles })}.signature`;
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/**
 * Whatever else the portal shell (header, sidebar, notification bell) fetches on mount.
 *
 * Playwright matches routes last-registered-first, so this catch-all must be registered *before*
 * every more specific handler below — including the auth stub — or it would shadow them instead of
 * falling back for the requests they don't cover.
 */
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

interface MockUser {
  id: string;
  school_id: string;
  email: string;
  display_name: string | null;
  status: "invited" | "active" | "suspended" | "archived";
  roles: string[];
  email_verified_at: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

function makeUser(overrides: Partial<MockUser> & Pick<MockUser, "id">): MockUser {
  return {
    school_id: "school-1",
    email: "jamie@example.edu",
    display_name: "Jamie Chen",
    status: "active",
    roles: ["INSTRUCTOR"],
    email_verified_at: "2026-08-01T00:00:00.000Z",
    last_login_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Extracts the `userId` path segment from `/api/(admin/)?users/{userId}(/...)`. */
function userIdFrom(url: string): string {
  const match = /\/api\/(?:admin\/)?users\/([^/?]+)/.exec(url);
  if (!match?.[1]) throw new Error(`Could not extract userId from ${url}`);
  return match[1];
}

async function stubUsersBackend(page: Page) {
  const users: MockUser[] = [makeUser({ id: "user-1" })];
  let nextId = 2;

  // Trailing `*` (not present after `/role`, `/deactivate`, or a single-user path below): the list
  // request carries a query string (`?limit=25&role=...`), which an exact-suffix pattern would miss
  // and silently fall through to the shell catch-all instead of this handler.
  await page.route("**/api/users*", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/users") return route.fallback();
    const request = route.request();
    if (request.method() === "GET") {
      return fulfillJson(route, 200, { users, next_cursor: null });
    }
    if (request.method() === "POST") {
      const body = request.postDataJSON() as {
        email: string;
        display_name?: string;
        role: string;
      };
      const created = makeUser({
        id: `user-${nextId++}`,
        email: body.email,
        display_name: body.display_name ?? null,
        status: "invited",
        roles: [body.role],
      });
      users.unshift(created);
      return fulfillJson(route, 201, created);
    }
    return fulfillJson(route, 405, {});
  });

  await page.route("**/api/users/*/role", async (route) => {
    const userId = userIdFrom(route.request().url());
    const body = route.request().postDataJSON() as { role: string };
    const user = users.find((candidate) => candidate.id === userId);
    if (user) user.roles = [body.role];
    return fulfillJson(route, 200, user);
  });

  await page.route("**/api/users/*/deactivate", async (route) => {
    const userId = userIdFrom(route.request().url());
    const user = users.find((candidate) => candidate.id === userId);
    if (user) user.status = "suspended";
    return fulfillJson(route, 200, {
      status: "suspended",
      revoked: 1,
      denylisted: 1,
      invitations_revoked: 0,
    });
  });

  await page.route("**/api/users/*", async (route) => {
    const userId = userIdFrom(route.request().url());
    const body = route.request().postDataJSON() as { display_name?: string };
    const user = users.find((candidate) => candidate.id === userId);
    if (user && body.display_name !== undefined) user.display_name = body.display_name;
    return fulfillJson(route, 200, user);
  });

  // Non-empty, so the deactivation dialog's consequence text ("this will end N sessions across M
  // devices") has something real to report rather than the no-op "nothing active" branch.
  await page.route("**/api/admin/users/*/sessions", (route) =>
    fulfillJson(route, 200, {
      sessions: [
        {
          id: "session-1",
          device_id: "device-1",
          device_name: "Jamie's laptop",
          channel: "web",
          user_agent: "Mozilla/5.0",
          ip_address: "203.0.113.10",
          issued_at: "2026-08-14T08:00:00.000Z",
          expires_at: "2026-09-13T08:00:00.000Z",
        },
      ],
    }),
  );
  await page.route("**/api/admin/users/*/devices", (route) =>
    fulfillJson(route, 200, {
      devices: [
        {
          id: "device-1",
          platform: "web",
          last_seen: "2026-08-14T08:00:00.000Z",
          created_at: "2026-08-01T00:00:00.000Z",
          active_session_count: 1,
        },
      ],
    }),
  );
}

test.describe("user management", () => {
  test("lists, creates, edits, and deactivates a user", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    await stubUsersBackend(page);

    await page.goto("/portal/admin/users");

    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    const grid = page.getByRole("region", { name: "School users" });
    await expect(grid.getByText("Jamie Chen")).toBeVisible();

    // --- Create ---
    await page.getByRole("button", { name: "New user" }).click();
    const createDialog = page.getByRole("dialog", { name: "New user" });
    await createDialog.getByLabel("Email").fill("new.teacher@example.edu");
    await createDialog.getByLabel("Display name").fill("Nadia Haddad");
    await createDialog.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "Instructor" }).click();
    await createDialog.getByRole("button", { name: "Send invite" }).click();

    await expect(page.getByText("Invited new.teacher@example.edu")).toBeVisible();
    await expect(grid.getByText("Nadia Haddad")).toBeVisible();

    // --- Edit (display name + role) ---
    const jamieRow = page.getByRole("row", { name: /Jamie Chen/ });
    await jamieRow.getByRole("button", { name: "Edit" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit user" });
    const nameField = editDialog.getByLabel("Display name");
    await nameField.fill("Jamie Okafor");
    await editDialog.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByText("User updated")).toBeVisible();
    await expect(grid.getByText("Jamie Okafor")).toBeVisible();

    // --- Deactivate ---
    const updatedRow = page.getByRole("row", { name: /Jamie Okafor/ });
    await updatedRow.getByRole("button", { name: "Deactivate" }).click();
    const deactivateDialog = page.getByRole("dialog", { name: "Deactivate user" });
    await expect(deactivateDialog.getByText(/This will end/)).toBeVisible();
    await deactivateDialog.getByRole("button", { name: "Deactivate" }).click();

    await expect(page.getByText("Jamie Okafor deactivated")).toBeVisible();
    await expect(updatedRow.getByText("Suspended")).toBeVisible();
    // A suspended user has no further deactivate action.
    await expect(updatedRow.getByRole("button", { name: "Deactivate" })).toHaveCount(0);
  });

  test("filters the list by role", async ({ page }) => {
    await stubPortalShellDefaults(page);
    await stubAuthenticatedSession(page);
    await stubUsersBackend(page);

    await page.goto("/portal/admin/users");

    const grid = page.getByRole("region", { name: "School users" });
    await expect(grid.getByText("Jamie Chen")).toBeVisible();

    const roleRequest = page.waitForRequest(
      (request) => request.url().includes("/api/users") && request.url().includes("role=STUDENT"),
    );
    await page.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "Student" }).click();
    await roleRequest;
  });
});
