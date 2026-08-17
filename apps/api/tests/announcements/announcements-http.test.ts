/**
 * Announcement management HTTP tests (ST-194).
 *
 * Exercises the full HTTP path — JWT auth, permission gate, real tenant transaction with RLS armed,
 * real audience resolution against app.user_roles / app.enrollments, real app.notifications writes —
 * for POST/GET /api/announcements. This is the "targeted announcement reaches only the intended
 * audience" acceptance criterion proved at the layer that can actually prove it: a network-mocked
 * frontend e2e test can only prove the UI sends the right request, not that the backend honors it.
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/announcements/announcements-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  createUser as createUserFactory,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

function jsonBody(body: unknown): { headers: Record<string, string>; body: string } {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

interface AnnouncementResponse {
  id: string;
  status: "scheduled" | "published";
  recipient_count: number;
  notified_count: number;
}

interface NotificationsResponse {
  notifications: { title: string; body: string }[];
}

async function createAnnouncement(
  fixture: TenantFixture,
  body: unknown,
): Promise<{ status: number; body: AnnouncementResponse }> {
  const res = await authenticatedRequest(
    harness!,
    "POST",
    "/api/announcements",
    { schoolId: fixture.schoolId, userId: fixture.users.ORG_ADMIN.id, roles: [ROLES.ORG_ADMIN] },
    jsonBody(body),
  );
  return { status: res.status, body: (await res.json()) as AnnouncementResponse };
}

async function inboxTitlesOf(fixture: TenantFixture, userId: string): Promise<string[]> {
  const res = await authenticatedRequest(harness!, "GET", "/api/notifications", {
    schoolId: fixture.schoolId,
    userId,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as NotificationsResponse;
  return body.notifications.map((n) => n.title);
}

describeDb("announcement management HTTP", () => {
  test("a role-targeted announcement reaches only that role", async () => {
    const fixture = await createFullTenant(database!.sql);
    const title = `Role notice ${crypto.randomUUID().slice(0, 8)}`;

    const { status, body } = await createAnnouncement(fixture, {
      title,
      body: "Instructors only: staff meeting moved to Friday.",
      mandatory: true,
      audience_type: "role",
      audience_role: "INSTRUCTOR",
    });

    expect(status).toBe(201);
    expect(body.status).toBe("published");
    expect(body.recipient_count).toBe(1);
    expect(body.notified_count).toBe(1);

    expect(await inboxTitlesOf(fixture, fixture.users.INSTRUCTOR.id)).toContain(title);
    // Negative controls: every other seeded role must not have received it (the fixture seeds one
    // user per role, so this is the whole rest of the school).
    for (const role of Object.keys(fixture.users) as (keyof typeof fixture.users)[]) {
      if (role === "INSTRUCTOR") continue;
      expect(await inboxTitlesOf(fixture, fixture.users[role].id)).not.toContain(title);
    }
  });

  test("a class-targeted announcement reaches only actively enrolled students, not the lead teacher", async () => {
    const fixture = await createFullTenant(database!.sql);
    const title = `Class notice ${crypto.randomUUID().slice(0, 8)}`;

    const { status, body } = await createAnnouncement(fixture, {
      title,
      body: "Field trip permission slips due Monday.",
      mandatory: true,
      audience_type: "class",
      audience_class_id: fixture.cls.id,
    });

    expect(status).toBe(201);
    expect(body.recipient_count).toBe(1);
    expect(body.notified_count).toBe(1);

    expect(await inboxTitlesOf(fixture, fixture.students[0]!.userId)).toContain(title);
    expect(await inboxTitlesOf(fixture, fixture.teachers[0]!.userId)).not.toContain(title);
    expect(await inboxTitlesOf(fixture, fixture.users.STUDENT.id)).not.toContain(title);
  });

  test("a non-mandatory announcement is suppressed for a recipient who disabled it, delivered to one who didn't", async () => {
    const fixture = await createFullTenant(database!.sql);

    const optedOutUser = await createUserFactory(database!.sql, fixture.schoolId, {
      email: `opted-out@test-${fixture.schoolSlug}.local`,
    });
    await assignRole(database!.sql, fixture.schoolId, optedOutUser.id, ROLES.SUPPORT_AGENT);

    const disableRes = await authenticatedRequest(
      harness!,
      "PATCH",
      "/api/notification-preferences",
      { schoolId: fixture.schoolId, userId: optedOutUser.id },
      jsonBody({
        preferences: [{ notification_type: "ANNOUNCEMENT", channel: "in_app", enabled: false }],
      }),
    );
    expect(disableRes.status).toBe(200);

    const title = `Optional notice ${crypto.randomUUID().slice(0, 8)}`;
    const { status, body } = await createAnnouncement(fixture, {
      title,
      body: "Optional: the cafeteria menu changed for next week.",
      mandatory: false,
      audience_type: "role",
      audience_role: "SUPPORT_AGENT",
    });

    expect(status).toBe(201);
    // Both the fixture's seeded SUPPORT_AGENT and the one just created hold the role.
    expect(body.recipient_count).toBe(2);
    expect(body.notified_count).toBe(1);

    expect(await inboxTitlesOf(fixture, optedOutUser.id)).not.toContain(title);
    expect(await inboxTitlesOf(fixture, fixture.users.SUPPORT_AGENT.id)).toContain(title);
  });

  test("a school-wide mandatory announcement still reaches a recipient who disabled the non-mandatory type", async () => {
    const fixture = await createFullTenant(database!.sql);

    await authenticatedRequest(
      harness!,
      "PATCH",
      "/api/notification-preferences",
      { schoolId: fixture.schoolId, userId: fixture.users.PARENT.id },
      jsonBody({
        preferences: [{ notification_type: "ANNOUNCEMENT", channel: "in_app", enabled: false }],
      }),
    );

    const title = `Mandatory notice ${crypto.randomUUID().slice(0, 8)}`;
    const { status, body } = await createAnnouncement(fixture, {
      title,
      body: "Campus closed tomorrow for a public holiday.",
      mandatory: true,
      audience_type: "school",
    });

    expect(status).toBe(201);
    expect(body.notified_count).toBe(body.recipient_count);
    expect(await inboxTitlesOf(fixture, fixture.users.PARENT.id)).toContain(title);
  });

  test("a scheduled (future) announcement is not published, and reports zero reach until it is", async () => {
    const fixture = await createFullTenant(database!.sql);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const { status, body } = await createAnnouncement(fixture, {
      title: "Scheduled for later",
      body: "This should not send yet.",
      mandatory: true,
      audience_type: "school",
      scheduled_at: future,
    });

    expect(status).toBe(201);
    expect(body.status).toBe("scheduled");
    expect(body.recipient_count).toBe(0);
    expect(body.notified_count).toBe(0);
  });

  test("only a caller holding notification:manage may compose an announcement", async () => {
    const fixture = await createFullTenant(database!.sql);

    const res = await authenticatedRequest(
      harness!,
      "POST",
      "/api/announcements",
      { schoolId: fixture.schoolId, userId: fixture.users.STUDENT.id, roles: [ROLES.STUDENT] },
      jsonBody({
        title: "Should be forbidden",
        body: "A student should not be able to send this.",
        mandatory: false,
        audience_type: "school",
      }),
    );

    expect(res.status).toBe(403);
  });

  test("history list carries reach stats and paginates newest first", async () => {
    const fixture = await createFullTenant(database!.sql);

    await createAnnouncement(fixture, {
      title: "First",
      body: "Body one.",
      mandatory: true,
      audience_type: "role",
      audience_role: "STUDENT",
    });
    await createAnnouncement(fixture, {
      title: "Second",
      body: "Body two.",
      mandatory: true,
      audience_type: "role",
      audience_role: "STUDENT",
    });

    const res = await authenticatedRequest(harness!, "GET", "/api/announcements?limit=10", {
      schoolId: fixture.schoolId,
      userId: fixture.users.ORG_ADMIN.id,
      roles: [ROLES.ORG_ADMIN],
    });
    expect(res.status).toBe(200);
    const listBody = (await res.json()) as {
      items: { title: string; recipient_count: number; notified_count: number }[];
    };
    expect(listBody.items[0]!.title).toBe("Second");
    expect(listBody.items[1]!.title).toBe("First");
    for (const item of listBody.items) {
      expect(item.recipient_count).toBeGreaterThan(0);
      expect(item.notified_count).toBe(item.recipient_count);
    }
  });
});
