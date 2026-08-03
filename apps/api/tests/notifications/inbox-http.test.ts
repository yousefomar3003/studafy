/**
 * In-app inbox HTTP tests (ST-142).
 *
 * Exercises the full HTTP path — JWT auth, route validation, tenant transaction with RLS armed, and
 * outbox emission — for the four inbox endpoints. Requires a live PostgreSQL instance and Redis-free
 * default, so it is gated on TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/notifications/inbox-http.test.ts
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  authenticatedRequest,
  createSchool,
  createTestApp,
  createTestDatabase,
  createUser as createUserFactory,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase } from "../harness";

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

async function insertNotification(
  schoolId: string,
  userId: string,
  overrides: { title?: string; readAt?: Date | null } = {},
): Promise<{ id: string }> {
  let result: { id: string } | undefined;
  await database!.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${schoolId}, true),
             set_config('app.user_id', ${userId}, true)
    `;

    // created_at/read_at come from the DB clock so ck_notifications_timestamps /
    // ck_notifications_read_at cannot flake under host-vs-container clock drift.
    const [clock] = await tx<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS now`;
    const readAt = overrides.readAt === undefined ? null : clock.now;

    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata, read_at, created_at)
      VALUES (
        ${schoolId}, ${userId},
        'GRADE_POSTED'::app.notification_type,
        ${overrides.title ?? "Grade posted"},
        'Amina scored 92 on the midterm.',
        '{"route":"/courses/course-1/grades"}'::jsonb,
        ${readAt},
        ${clock.now}
      )
      RETURNING id
    `;
    result = row;
  });
  return result!;
}

describeDb("in-app inbox HTTP", () => {
  test("list returns the recipient's notifications and a cursor contract", async () => {
    const school = await createSchool(database!.sql);
    const recipient = await createUserFactory(database!.sql, school.id);
    await insertNotification(school.id, recipient.id, { title: "first" });

    const res = await authenticatedRequest(harness!, "GET", "/api/notifications", {
      schoolId: school.id,
      userId: recipient.id,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: {
        id: string;
        title: string;
        read_at: null | string;
      }[];
      next_cursor: string | null;
    };
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]!.title).toBe("first");
    expect(body.notifications[0]!.read_at).toBeNull();
    expect(body.next_cursor).toBeNull();
  });

  test("unread-count returns the unread total", async () => {
    const school = await createSchool(database!.sql);
    const recipient = await createUserFactory(database!.sql, school.id);
    await insertNotification(school.id, recipient.id);
    await insertNotification(school.id, recipient.id);
    await insertNotification(school.id, recipient.id, { readAt: new Date() });

    const res = await authenticatedRequest(harness!, "GET", "/api/notifications/unread-count", {
      schoolId: school.id,
      userId: recipient.id,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { unread_count: number };
    expect(body.unread_count).toBe(2);
  });

  test("mark-read decrements the count and emits notification.read", async () => {
    const school = await createSchool(database!.sql);
    const recipient = await createUserFactory(database!.sql, school.id);
    await insertNotification(school.id, recipient.id);
    const target = await insertNotification(school.id, recipient.id);

    const res = await authenticatedRequest(
      harness!,
      "POST",
      `/api/notifications/${target.id}/read`,
      { schoolId: school.id, userId: recipient.id },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { unread_count: number };
    expect(body.unread_count).toBe(1);

    const events = await database!.sql`
      SELECT event_name, payload FROM app.outbox_events WHERE school_id = ${school.id}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]!.event_name).toBe(DOMAIN_EVENTS.NOTIFICATION_READ);
    expect(events[0]!.payload).toEqual({
      userId: recipient.id,
      notificationId: target.id,
      unreadCount: 1,
    });
  });

  test("read-all clears the inbox and emits notification.allRead", async () => {
    const school = await createSchool(database!.sql);
    const recipient = await createUserFactory(database!.sql, school.id);
    await insertNotification(school.id, recipient.id);
    await insertNotification(school.id, recipient.id);

    const res = await authenticatedRequest(harness!, "POST", "/api/notifications/read-all", {
      schoolId: school.id,
      userId: recipient.id,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { unread_count: number };
    expect(body.unread_count).toBe(0);

    const events = await database!.sql`
      SELECT event_name FROM app.outbox_events WHERE school_id = ${school.id}
    `;
    expect(events.map((r) => r.event_name)).toEqual([DOMAIN_EVENTS.NOTIFICATION_ALL_READ]);
  });

  test("cannot read another user's notification", async () => {
    const school = await createSchool(database!.sql);
    const recipient = await createUserFactory(database!.sql, school.id);
    const other = await createUserFactory(database!.sql, school.id);
    const otherNotification = await insertNotification(school.id, other.id);

    const res = await authenticatedRequest(
      harness!,
      "POST",
      `/api/notifications/${otherNotification.id}/read`,
      { schoolId: school.id, userId: recipient.id },
    );

    expect(res.status).toBe(404);
  });

  test("marking a nonexistent notification read returns 404", async () => {
    const school = await createSchool(database!.sql);
    const recipient = await createUserFactory(database!.sql, school.id);

    const res = await authenticatedRequest(
      harness!,
      "POST",
      `/api/notifications/${crypto.randomUUID()}/read`,
      { schoolId: school.id, userId: recipient.id },
    );

    expect(res.status).toBe(404);
  });

  test("rejects malformed query params", async () => {
    const school = await createSchool(database!.sql);
    const recipient = await createUserFactory(database!.sql, school.id);

    const res = await authenticatedRequest(harness!, "GET", "/api/notifications?limit=0", {
      schoolId: school.id,
      userId: recipient.id,
    });

    expect(res.status).toBe(400);
  });

  test("rejects a malformed cursor with 400", async () => {
    const school = await createSchool(database!.sql);
    const recipient = await createUserFactory(database!.sql, school.id);

    const res = await authenticatedRequest(
      harness!,
      "GET",
      "/api/notifications?cursor=not-a-cursor",
      {
        schoolId: school.id,
        userId: recipient.id,
      },
    );

    expect(res.status).toBe(400);
  });

  test("requires authentication", async () => {
    const res = await harness!.app.request("/api/notifications");
    expect(res.status).toBe(401);
  });
});
